import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from 'obsidian';
const nodepub = require('nodepub')
const JSZip = require('jszip')

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
	console.debug(method, data)
    try {
		const res = await requestUrl({
			url: `https://cloud.feedly.com/v3/${path}`,
			method,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
			body: JSON.stringify(data) ?? undefined
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

async function getSavedLater(accessToken: string) {
    console.log('access', accessToken)
    const articles: any[] = []
    const m = await apiCall(accessToken, 'markers/tags') as {taggedEntries: Record<string, any[]>}
    console.log(m)
    const globalSaved: string = Object.keys(m.taggedEntries).filter(x => x.includes('global.saved'))[0]
    const entries = m.taggedEntries[globalSaved] as any[]
    const entryRes = await apiCall(accessToken, 'entries/.mget', 'POST', entries) as any[]
    articles.push(...entryRes)
    return articles
}

interface GenerateEpubParams {
    id: string
    title: string
    publisher: string
    author: string
    cover?: string
    content: {
        title: string
        data: string
    }[]
    filePath: string
}

async function generateEpub(params: GenerateEpubParams): Promise<string> {
    const bookFile = nodepub.document({
        id: params.id,
        title: params.title,
        publisher: params.publisher,
        author: params.author,
        cover: params.cover,
    })
    bookFile.addCSS(`img { display: none; width: 0px; height: 0px }`)
    let i = 0
    for (const c of params.content) {
        bookFile.addSection(`${++i}. ${c.title}`, c.data)
    }
    const files = await bookFile.getFilesForEPUB()

    // 3. Initialize JSZip
    const zip = new JSZip();

    // 4. Add mimetype first and uncompressed
    console.log(files)
    const mimetypeFile = files.find((file: any) => file.name === 'mimetype');
    if (mimetypeFile) {
        zip.file(mimetypeFile.name, mimetypeFile.data, { compression: 'STORE' });
    }

    // 5. Add all other files
    const folders: Record<string, any> = {
        'META-INF': zip.folder('META-INF'),
        'OEBPF': zip.folder('OEBPF'),
    }
    folders['OEBPF/css'] = folders['OEBPF'].folder('css')
    folders['OEBPF/content'] = folders['OEBPF'].folder('content')
    folders['OEBPF/images'] = folders['OEBPF'].folder('images')

    for (const file of files) {
        if (file.name !== 'mimetype') {
            if (file.folder !== '') {
                console.log('    ', file.folder, file.name, file.content.length)
                folders[file.folder].file(file.name, file.content);
            } else {
                console.log('    ', file.name, file.content.length)
                zip.file(`${file.folder}/${file.name}`, file.content);
            }
        }
    }

    // 6. Generate the final EPUB Buffer
    const epubBuffer = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });

    // 9. Convert Node.js Buffer to ArrayBuffer for Obsidian's createBinary
    // This is crucial as Obsidian's API expects ArrayBuffer, not Node.js Buffer
    const arrayBuffer = epubBuffer.buffer.slice(epubBuffer.byteOffset, epubBuffer.byteOffset + epubBuffer.byteLength);

    // 10. Save the EPUB file to the vault
    const newFile: TFile = await this.app.vault.createBinary(`${params.filePath}.epub`, arrayBuffer);
    return newFile.path
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

		this.addCommand({
			id: 'epub',
			name: 'Generate ePub',
			callback: async () => {
				const filePath = `FeedlySync-${Date.now()}`
                console.debug(`Starting file ${filePath}`)
				const includeImages = false
				const articles: any[] = []
  				let continuation: string | undefined = undefined

				if (!this.settings.userId) {
					return new Notice('Missing Feedly user id')
				}
				if (!this.settings.accessToken) {
					return new Notice('Missing Feedly access token')
				}
				const userId = this.settings.userId
				const accessToken = this.settings.accessToken

				while (true) {
					const query = continuation ? `&continuation=${continuation}` : ''
					try {
                        const res = await apiCall(accessToken, `streams/contents?streamId=user/${userId}/category/global.all&unreadOnly=true&count=250${query}`) as {items: any[], continuation?: string}
                        const items = res.items
                        if (!items) {
                            console.error('err', res)
                            return
                        }
                        continuation = res.continuation
                        articles.push(...items)
                        if (items.length < 250) break
                    } catch (e) {
                        console.error(e)
                        if (e.message.includes('status 401')) {
                            console.error('Access token expired', e)
                            console.log(continuation)
                            return new Notice('Access token expired, request a new one')
                        }
                        if (e.message.includes('status 429')) {
                            console.error('API rate limit reached', e)
                            console.log(continuation)
                            return new Notice('API rate limit reached')
                        }
                    }
				}
				console.log(articles.length, 'items')

				const savedArticles = await getSavedLater(accessToken)
				console.log(savedArticles.length, 'saved items')
				articles.push(...savedArticles)

				function getContent(article: any) {
    				const articleContent = article.content?.content ?? article.summary?.content ?? article.fullContent
					// return articleContent.replace(/\<img .*\>/g, '')
					return articleContent
				}
				const articlesToExport = articles
					.filter(x => getContent(x) !== undefined)
				console.log(articlesToExport.length, 'filter-items')

				const contents = articlesToExport
                    .map(x => {
                    let data = 
    `<pre>---${x.canonicalUrl ? `
url: ${x.canonicalUrl}` : ''}
feedlyUrl: https://feedly.com/i/entry/${x.id}
title: ${x.title}
pubDate: ${dateToJournal(new Date(x.published ?? x.crawled))}
author: ${sanitizeFrontmatter(x.author ?? x.origin.title)}${x.origin?.title ? `
publisher: ${sanitizeFrontmatter(x.origin.title)}` : ''}
---</pre>

`
                    if (getContent(x)) {
                    data += `
                        <div>
                        ${getContent(x)}
                        </div>
                    `
                    }

                    return {
                        title: x.title,
                        author: x.author,
                        data,
                        css: "img { display: none; width: 0px; height: 0px; }"
                    }
                })

                const adapter = this.app.vault.adapter as any
                const newPath = await generateEpub({
                    id: '123-567',
                    title: `Your Evening Discourse for ${new Date().toDateString()}`,
                    publisher: 'Quillcast',
                    author: 'Evening Discourse',
                    content: contents,
                    filePath,
                })
                console.log(`EPUB file saved to: ${newPath}`);

                new Notice(`Generated ${filePath}.epub with ${articlesToExport.length} articles`)
			}
		})

        this.addCommand({
            id: 'cleanup',
            name: 'Delete all Feedly epub files',
            callback: async () => {
                const files = this.app.vault.getFiles(); // Get all files in the vault

                for (const file of files) {
                    if ((file.extension === 'epub') && file.basename.startsWith('FeedlySync')) {
                        console.log(file.basename)
                        await this.app.vault.trash(file, true); // Move to system trash
                    }
                }
            }
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
