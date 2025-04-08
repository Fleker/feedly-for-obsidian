import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath, requestUrl } from 'obsidian';

interface FeedlySettings {
	userId?: string
	accessToken?: string
	/** Timestamp of last sync. Used for querying. */
	lastSync?: number
	/** Stores the last time when a full sync began. */
	continuationTime?: number
	/** Save this token for continue sync if it was disrupted for some reason (API rate limit) */
	continuationToken?: string
	/** Path for folder to save all these files */
	annotationsFolder?: string
}

interface FeedlyAnnotatedEntry {
	annotation: {
		highlight?: {
			text: string
		}
		comment?: string
	}
	entry: {
		canonicalUrl: string
		id: string
		published?: number
		crawled: number
		author: string
		title: string
		origin?: {
			title: string
		}
	}
	created: number
}

const DEFAULT_SETTINGS: FeedlySettings = {
	annotationsFolder: 'Feedly Annotations'
}

const apiCall = async (accessToken: string, path: string, method = 'GET', data?: any) => {
 	console.debug(`https://cloud.feedly.com/v3/${path}`)
	try {
		const res = await requestUrl({
			url: `https://cloud.feedly.com/v3/${path}`,
			method,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
			body: data ?? undefined
		})
  	return res.json
	} catch (e) {
		console.debug(e)
		throw new Error(e)
	}
}

function sanitizeFrontmatter(v: string = '') {
  return v.replace(/:/g, ' - ')
}

function dateToJournal(date: Date) {
	return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}

function getInitialContent(entry: FeedlyAnnotatedEntry) {
  return `---${entry.entry.canonicalUrl ? `
url: ${entry.entry.canonicalUrl}` : ''}
feedlyUrl: https://feedly.com/i/entry/${entry.entry.id}
date: ${dateToJournal(new Date(entry.created))}
pubDate: ${dateToJournal(new Date(entry.entry.published ?? entry.entry.crawled))}
author: ${sanitizeFrontmatter(entry.entry.author)}${entry.entry.origin?.title ? `
publisher: ${sanitizeFrontmatter(entry.entry.origin.title)}` : ''}
---
`
}

function getAppendContent(entry: FeedlyAnnotatedEntry) {
  if (entry.annotation.highlight) {
    return `

> ${entry.annotation.highlight.text.replace(/\n/g, `
>
> `)}`
  } else if (entry.annotation.comment) {
    return `
    
${entry.annotation.comment}`
  }
  console.warn('No append content for', entry.entry.title)
  return ''
}

async function getAnnotations(accessToken: string, continuation?: string, syncTime: number = 0) {
  try {
		const a = await apiCall(accessToken, `annotations/journal?newerThan=${syncTime}&withEntries=true&count=100${continuation ? `&continuation=${continuation}` : ''}`)
		if (a.errorCode) {
			throw new Error(a)
		}
		return {
			entries: a.entries,
			continuation: a.continuation,
			count: a.entries.length
		}
	} catch (e) {
		console.error(e)
		if (e.message.includes('status 401')) {
			console.error('Access token expired', e)
			console.log(continuation)
			throw new Error('Access token expired, request a new one')
		}
		if (e.message.includes('status 429')) {
			console.error('API rate limit reached', e)
			console.log(continuation)
			throw new Error('API rate limit reached')
		}
	}
}

export default class FeedlyPlugin extends Plugin {
	settings: FeedlySettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'sync',
			name: 'Sync annotated articles',
			callback: async () => {
				await this.loadSettings()
				if (!this.settings.userId) {
					return new Notice('Missing Feedly user id')
				}
				if (!this.settings.accessToken) {
					return new Notice('Missing Feedly access token')
				}

				let entryCounter = 0
				let continuationToken = this.settings.continuationToken ?? undefined
				if (!continuationToken) {
					// Beginning a full, multi-step sync
					this.settings.continuationTime = Date.now()
					await this.saveSettings(this.settings)
				}
				new Notice('Beginning to download Feedly annotations')

				const folderName = this.settings.annotationsFolder ?? 'Feedly Annotations'
				const doesFolderExist = this.app.vault.getFolderByPath(folderName)
				if (!doesFolderExist) {
					await this.app.vault.createFolder(folderName)
				}
				const processAnnotations = async (entries: FeedlyAnnotatedEntry[]) => {
					for (const e of entries) {
						// Remove slashes.
						// File name cannot contain any of the following characters: * " \ / < > : | ?
						const sanitizedFileName = e.entry.title.replace(/[*"\/<>:|?]/g, '')
						const filename = `${sanitizedFileName}.md`
						const path = normalizePath(`${folderName}/${filename}`)
						let obsidianFile = this.app.vault.getFileByPath(path)
						// console.log(path)
						if (!obsidianFile) {
							// Add the frontmatter
							obsidianFile = await this.app.vault.create(path, getInitialContent(e))
						}
						// Add the highlight or comment of this entry
						await this.app.vault.append(obsidianFile!, getAppendContent(e))
						entryCounter++
					}
				}
				// console.log(this.settings.continuationTime, this.settings.continuationToken, this.settings.lastSync)

				while (true) {
					try {
						const res = await getAnnotations(this.settings.accessToken, continuationToken, this.settings.lastSync)
						// console.log('res', res?.count, res?.continuation)
						if (res === undefined) break
						continuationToken = res.continuation
						await processAnnotations(res.entries)
						if (res.count < 100) {
							console.debug(`only got ${res.count} entries`)
							this.settings.continuationToken = undefined // Reset
							this.settings.lastSync = this.settings.continuationTime
							this.saveSettings(this.settings)
							new Notice('All Feedly annotations synced')
							break
						}
						this.settings.continuationToken = continuationToken
						// Save token for the future
						this.saveSettings(this.settings)
						console.debug(`>    at ${continuationToken} ...`)
					} catch (e) {
						if (e.message.includes('API rate limit')) {
							new Notice('The Feedly API rate limit has been reached, continue later')
						} else {
							new Notice(e.message)
							console.error(e)
						}
						break;
					}
				}
				new Notice(`Synced ${entryCounter} annotations`)
			},
		})

		this.addSettingTab(new FeedlySettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(settings: FeedlySettings) {
		await this.saveData(settings);
	}
}

class FeedlySettingTab extends PluginSettingTab {
	plugin: FeedlyPlugin;
	settings: FeedlySettings;

	constructor(app: App, plugin: FeedlyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async display(): Promise<void> {
		const {containerEl} = this;
		this.settings = await this.plugin.loadData() ?? DEFAULT_SETTINGS

		containerEl.empty();

		new Setting(containerEl)
			.setName('Feedly user id')
			.addText((component) => {
				component.setValue(this.settings.userId ?? '')
				component.onChange(async (value) => {
					this.settings.userId = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		new Setting(containerEl)
			.setName('Access token')
			.addText((component) => {
				component.setValue(this.settings.accessToken ?? '')
				component.onChange(async (value) => {
					this.settings.accessToken = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		new Setting(containerEl)
			.setName('Sync directory')
			.addText((component) => {
				component.setValue(this.settings.annotationsFolder ?? '')
				component.onChange(async (value) => {
					this.settings.annotationsFolder = value
					await this.plugin.saveSettings(this.settings)
				})
			})

			new Setting(containerEl)
				.setName('Create a developer access token')
				.addButton((component) => {
					component.setButtonText('Connect')
					component.onClick(() => {
						const feedlyDevUrl = 'https://feedly.com/v3/auth/dev'
						window.location.href = feedlyDevUrl
					})
				})

		// containerEl.createEl("h2", { text: "Debug" });

		// new Setting(containerEl)
		// 		.setName("lastSync")
		// 		.addText(text => text.setValue(this.settings.lastSync?.toString() ?? ''));

		// new Setting(containerEl)
		// .setName("continuationTime")
		// .addText(text => text.setValue(this.settings.continuationTime?.toString() ?? ''));

		// new Setting(containerEl)
		// .setName("continuationToken")
		// .addText(text => text.setValue(this.settings.continuationToken?.toString() ?? ''));
	}
}
