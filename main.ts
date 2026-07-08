import { App, FileManager, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { InstapaperClient } from './instapaper';
import nodepub, { NodepubFile } from 'nodepub';
import JSZip from 'jszip';

interface FeedlyArticle {
	id: string;
	title: string;
	author?: string;
	canonicalUrl?: string;
	published?: number;
	crawled?: number;
	origin?: {
		title: string;
	};
	content?: {
		content?: string;
	};
	summary?: {
		content?: string;
	};
	fullContent?: string;
}

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
	/** Comma-separated list of publishers to exclude from epub generation */
	filteredPublishers?: string
	instapaperConsumerKey?: string
	instapaperConsumerSecret?: string
	instapaperUsername?: string
	instapaperPassword?: string
	instapaperLimit?: number
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

const apiCall = async (accessToken: string, path: string, method = 'GET', data?: unknown) => {
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

async function setEntryFrontmatter(fileManager: FileManager, file: TFile, entry: FeedlyAnnotatedEntry) {
	await fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		if (entry.entry.canonicalUrl) {
			frontmatter.url = entry.entry.canonicalUrl;
		}
		frontmatter.feedlyUrl = `https://feedly.com/i/entry/${entry.entry.id}`;
		frontmatter.date = dateToJournal(new Date(entry.created));
		frontmatter.pubDate = dateToJournal(new Date(entry.entry.published ?? entry.entry.crawled));
		if (entry.entry.author) {
			frontmatter.author = sanitizeFrontmatter(entry.entry.author);
		}
		if (entry.entry.origin?.title) {
			frontmatter.publisher = sanitizeFrontmatter(entry.entry.origin.title);
		}
	});
}

function getAppendContent(entry: FeedlyAnnotatedEntry) {
  if (!entry.annotation) {
    console.warn('No append content for', entry.entry.title)
	console.warn(entry)
	return ``
  }

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

async function getSavedLater(accessToken: string, userId: string) {
    const articles: FeedlyArticle[] = []
    let continuation: string | undefined = undefined
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000)

    while (true) {
        const query = continuation ? `&continuation=${continuation}` : ''
        const res = await apiCall(accessToken, `streams/contents?streamId=user/${userId}/tag/global.saved&count=250${query}`) as {items: FeedlyArticle[], continuation?: string}
        
        if (!res.items || res.items.length === 0) break
        
        // Filter items that are newer than 30 days
        const recentItems = res.items.filter(item => {
            const publishedAt = item.published ?? item.crawled ?? 0
            return publishedAt > thirtyDaysAgo
        })
        
        articles.push(...recentItems)
		articles.forEach(a => {
			console.log(getContent(a))
		})
        
        // If some items in this batch were older than 30 days, we can stop fetching entirely
        // since the stream is generally returned in reverse-chronological order.
        if (recentItems.length < res.items.length) {
            break
        }

        continuation = res.continuation
        if (!continuation) break
    }
    return articles
}

async function authorizeInstapaper(client: InstapaperClient, username: string, password: string, consumerKey: string, consumerSecret: string) {
	try {
		await client.authenticate(username, password)
		return true
	} catch (e) {
		new Notice(`Error authorizing Instapaper`)
		console.error(e)
	}
	return false
}

async function getBookmarks(client: InstapaperClient, limit: number = 25) {
	try {
		const bookmarks = await client.getBookmarks(limit)
		return bookmarks
	} catch (e) {
		new Notice(`Error fetching Instapaper bookmarks`)
		console.error(e)
	}
	return null
}

async function getInstapaperArticles(
	consumerKey: string,
	consumerSecret: string,
	username: string,
	password: string,
	limit: number = 25,
): Promise<{ title: string, author: string, data: string, css: string }[]> {
	const progressNotice = new Notice('Fetching Instapaper articles...', 0)
	const client = new InstapaperClient(consumerKey, consumerSecret)
	const authorized = await authorizeInstapaper(client, username, password, consumerKey, consumerSecret)
	if (!authorized) {
		progressNotice.hide()
		return []
	}

	const bookmarks = await getBookmarks(client, limit)
	if (!bookmarks || !Array.isArray(bookmarks)) {
		progressNotice.hide()
		return []
	}

	const validBookmarks = bookmarks.filter(b => b && b.type === 'bookmark' && b.bookmark_id && b.title)
	if (validBookmarks.length === 0) {
		progressNotice.setMessage('Instapaper progress: Done (0 articles)')
		return []
	}

	const out: { title: string, author: string, data: string, css: string }[] = []
	const results: ({ title: string, author: string, data: string, css: string } | null)[] = new Array(validBookmarks.length).fill(null)
	let skippedCount = 0
	let processedCount = 0
	progressNotice.setMessage(`Instapaper progress: 0/${validBookmarks.length}`)

	const concurrency = 15
	let currentIndex = 0

	const worker = async () => {
		while (currentIndex < validBookmarks.length) {
			const index = currentIndex++
			const b = validBookmarks[index]
			const { bookmark_id, url, title } = b
			try {
				const content = await client.getText(bookmark_id)
				if (content === null) {
					skippedCount++
				} else {
					const saveDate = b.time ? dateToJournal(new Date(b.time * 1000)) : 'Unknown'
					const author = b.author ?? 'Unknown'
					const data = `<h2>${title}</h2>
<pre>---
url: ${url}
instapaperUrl: https://www.instapaper.com/read/${bookmark_id}
title: ${title}
saveDate: ${saveDate}${b.description ? `
description: ${sanitizeFrontmatter(b.description)}` : ''}
---</pre>
<div>${content}</div>`
					results[index] = { 
						title, 
						author, 
						data, 
						css: "img { display: none; width: 0px; height: 0px; }" 
					}
				}
			} catch (e) {
				const errorMsg = e.message || e.toString()
				if (errorMsg.includes('1550')) {
					console.warn(`Instapaper: Unable to parse text for "${title}" (1550). This article will be skipped.`)
				} else {
					console.error(`Instapaper: Unexpected error fetching "${title}":`, e)
				}
				skippedCount++
			} finally {
				processedCount++
				progressNotice.setMessage(`Instapaper progress: ${processedCount}/${validBookmarks.length}`)
			}
		}
	}

	const workers = []
	for (let i = 0; i < Math.min(concurrency, validBookmarks.length); i++) {
		workers.push(worker())
	}
	await Promise.all(workers)

	for (const item of results) {
		if (item !== null) {
			out.push(item)
		}
	}

	progressNotice.setMessage(`Instapaper progress: Done (${out.length}/${validBookmarks.length} articles${skippedCount > 0 ? `, ${skippedCount} skipped` : ''})`)

	return out
}

function cleanContent(html: string) {
	if (!html) return html;

	let content = html;

	// 1. Remove preheaders and display:none blocks which often contain preview text we don't want in the body
	content = content.replace(/<div[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, '');

	// 2. Remove known ad and social blocks
	content = content.replace(/<div[^>]*data-block="(top-ad|ad|social)"[^>]*>[\s\S]*?<\/div>/gi, '');

	// 3. Remove "View in browser" links and similar noise
	content = content.replace(/<a[^>]*>[^<]*View in browser[^<]*<\/a>/gi, '');
	content = content.replace(/<a[^>]*>[^<]*View on [^<]*<\/a>/gi, '');

	// 4. Flatten Tables
	// We replace table tags with nothing, and td/tr with divs to keep the flow
	for (let i = 0; i < 3; i++) {
		content = content
			.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, '$1')
			.replace(/<tbody[^>]*>([\s\S]*?)<\/tbody>/gi, '$1')
			.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '<div>$1</div>')
			.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, '<div>$1</div>');
	}

	// 5. Strip overly complex inline styles that interfere with e-reader rendering
	content = content.replace(/style="[^"]{40,}"/gi, '');

	// 6. Final cleanup
	return content
		.replace(/<img .*?>/g, '') // Remove images
		.replace(/<div>\s*<\/div>/gi, '') // Remove empty divs
		.trim();
}
function getContent(article: FeedlyArticle) {
	const contents = [
		article?.content?.content,
		article?.summary?.content,
		article?.fullContent,
	].filter(Boolean) as string[]; // Filter out undefined/null and assert as string[]

	if (contents.length > 0) {
		// Sort by length in descending order and pick the first one
		return cleanContent(contents.sort((a, b) => b.length - a.length)[0])
	}
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
    const mimetypeFile = files.find((file: NodepubFile) => file.name === 'mimetype');
    if (mimetypeFile) {
        zip.file(mimetypeFile.name, mimetypeFile.data ?? mimetypeFile.content, { compression: 'STORE' });
    }

    // 5. Add all other files
    const folders: Record<string, JSZip | null> = {
        'META-INF': zip.folder('META-INF'),
        'OEBPF': zip.folder('OEBPF'),
    }
    if (folders['OEBPF']) {
        folders['OEBPF/css'] = folders['OEBPF'].folder('css')
        folders['OEBPF/content'] = folders['OEBPF'].folder('content')
        folders['OEBPF/images'] = folders['OEBPF'].folder('images')
    }

    for (const file of files) {
        if (file.name !== 'mimetype') {
            if (file.folder !== '') {
                console.log('    ', file.folder, file.name, file.content.length)
                folders[file.folder]?.file(file.name, file.content);
            } else {
                console.log('    ', file.name, file.content.length)
                zip.file(`${file.folder}/${file.name}`, file.content);
            }
        }
    }

    // 6. Generate the final EPUB Buffer
    const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer', mimeType: 'application/epub+zip' });

    // 7. Save the EPUB file to the vault
    const newFile: TFile = await this.app.vault.createBinary(`${params.filePath}.epub`, arrayBuffer);
    return newFile.path
}

export default class FeedlyPlugin extends Plugin {
	settings: FeedlySettings;

	async onload() {
		await this.loadSettings();

		this.registerEvent(
			this.app.workspace.on('url-menu', (menu, url) => {
				if (
					this.settings.instapaperConsumerKey &&
					this.settings.instapaperConsumerSecret &&
					this.settings.instapaperUsername &&
					this.settings.instapaperPassword
				) {
					menu.addItem((item) => {
						item.setTitle('Add to Instapaper')
							.setIcon('bookmark')
							.onClick(async () => {
								new Notice(`Saving ${url} to Instapaper...`);
								try {
									const client = new InstapaperClient(
										this.settings.instapaperConsumerKey!,
										this.settings.instapaperConsumerSecret!
									);
									await client.authenticate(
										this.settings.instapaperUsername!,
										this.settings.instapaperPassword!
									);
									await client.addBookmark(url);
									new Notice('Saved to Instapaper!');
								} catch (error) {
									console.error('Failed to save to Instapaper:', error);
									new Notice('Failed to save to Instapaper');
								}
							});
					});
				}
			})
		);

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
						// File name cannot contain any of the following characters: * " \ / < > : | ?
						const sanitizedFileName = e.entry.title.replace(new RegExp('[*"/<>:|?]', 'g'), '')
						const filename = `${sanitizedFileName}.md`
						const path = normalizePath(`${folderName}/${filename}`)
						let obsidianFile = this.app.vault.getFileByPath(path)
						console.log(path, obsidianFile)
						if (!obsidianFile) {
							// Add the frontmatter
							try {
								obsidianFile = await this.app.vault.create(path, '')
								await setEntryFrontmatter(this.app.fileManager, obsidianFile, e)
							} catch (error) {
								if (error.message.includes('File already exists')) {
									// This is a situation which can happen if
									// two files have the same name BUT
									// different case sensitivity. So it would
									// fail a filename lookup check BUT would
									// also fail creating the file.
									// To fix this, we will generate a unique
									// filename.
									console.warn(error)
									const appendedId = e.entry.id.replace(new RegExp('[*"/<>:|?]', 'g'), '')
									const uniqueFilename = `${sanitizedFileName}-${appendedId}.md`
									const uniquePath = normalizePath(`${folderName}/${uniqueFilename}`)
									console.warn(`use path ${uniquePath}`)
									obsidianFile = this.app.vault.getFileByPath(uniquePath)
									if (!obsidianFile) {
										obsidianFile = await this.app.vault.create(uniquePath, '')
										await setEntryFrontmatter(this.app.fileManager, obsidianFile, e)
									}
								}
							}
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
							await this.saveSettings(this.settings)
							new Notice('All Feedly annotations synced')
							break
						}
						this.settings.continuationToken = continuationToken
						// Save token for the future
						await this.saveSettings(this.settings)
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
				const articles: FeedlyArticle[] = []
  				let continuation: string | undefined = undefined

				if (!this.settings.userId) {
					return new Notice('Missing Feedly user id')
				}
				if (!this.settings.accessToken) {
					return new Notice('Missing Feedly access token')
				}
				const userId = this.settings.userId
				const accessToken = this.settings.accessToken
                new Notice('Beginning to download articles...')

				while (true) {
					const query = continuation ? `&continuation=${continuation}` : ''
					try {
                        const res = await apiCall(accessToken, `streams/contents?streamId=user/${userId}/category/global.all&unreadOnly=true&count=250${query}`) as {items: FeedlyArticle[], continuation?: string}
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

				try {
					const savedArticles = await getSavedLater(accessToken, userId)
					console.log(savedArticles.length, 'saved items')
					articles.push(...savedArticles)
				} catch (e) {
					console.error(e)
					new Notice(`Error fetching saved articles ${e}`)
				}

				const blockedPublishers = (this.settings.filteredPublishers ?? '')
					.split(',')
					.map(p => p.trim().toLowerCase())
					.filter(p => p.length > 0)
				const articlesToExport = articles
					.filter(x => getContent(x) !== undefined)
					.filter(x => {
						const publisher = (x.origin?.title ?? '').toLowerCase()
						return !blockedPublishers.some(p => publisher.includes(p))
					})
				console.log(articlesToExport.length, 'filter-items')

				const contents = articlesToExport
                    .map(x => {
                    let data = 
    `<h2>${x.title}</h2>
<pre>---${x.canonicalUrl ? `
url: ${x.canonicalUrl}` : ''}
feedlyUrl: https://feedly.com/i/entry/${x.id}
title: ${x.title}
pubDate: ${dateToJournal(new Date(x.published ?? x.crawled ?? 0))}
author: ${sanitizeFrontmatter(x.author ?? x.origin?.title ?? '')}${x.origin?.title ? `
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

				let totalArticles = articlesToExport.length
				// Include Instapaper articles if credentials are configured
				if (this.settings.instapaperConsumerKey &&
					this.settings.instapaperConsumerSecret &&
					this.settings.instapaperUsername &&
					this.settings.instapaperPassword) {
					try {
						const instapaperContents = await getInstapaperArticles(
							this.settings.instapaperConsumerKey,
							this.settings.instapaperConsumerSecret,
							this.settings.instapaperUsername,
							this.settings.instapaperPassword,
							this.settings.instapaperLimit ?? 25,
						)
						contents.push(...instapaperContents)
						totalArticles += instapaperContents.length
						console.log(instapaperContents.length, 'instapaper articles added')
					} catch (e) {
						console.error(e)
						new Notice(`Error fetching Instapaper articles: ${e}`)
					}
				}

                const newPath = await generateEpub({
                    id: '123-567',
                    title: `Your Evening Discourse for ${new Date().toDateString()}`,
                    publisher: 'Quillcast',
                    author: 'Evening Discourse',
                    content: contents,
                    filePath,
                })
                console.log(`EPUB file saved to: ${newPath}`);

                new Notice(`Generated ${filePath}.epub with ${totalArticles} articles`, 0)
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
                        await this.app.fileManager.trashFile(file);
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

	onExternalSettingsChange(): void {
		this.display();
	}

	display(): void {
		const {containerEl} = this;
		this.settings = this.plugin.settings ?? DEFAULT_SETTINGS;

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
			.setDesc('Select an existing folder or enter a custom folder path below')
			.addDropdown((dropdown) => {
				const folders = this.app.vault.getAllFolders(true);
				for (const folder of folders) {
					const path = folder.path === '/' ? '' : folder.path;
					const label = folder.path === '/' ? 'Vault root (/)' : folder.path;
					dropdown.addOption(path, label);
				}
				dropdown.setValue(this.settings.annotationsFolder ?? '');
				dropdown.onChange(async (value) => {
					this.settings.annotationsFolder = value;
					await this.plugin.saveSettings(this.settings);
					this.display();
				});
			})
			.addText((component) => {
				component.setValue(this.settings.annotationsFolder ?? '')
				component.onChange(async (value) => {
					this.settings.annotationsFolder = value
					await this.plugin.saveSettings(this.settings)
				})
			})

			new Setting(containerEl)
				.setName('Filtered publishers')
				.setDesc('Comma-separated list of publishers to exclude from epub generation (e.g. "The Guardian, BBC News")')
				.addText((component) => {
					component.setPlaceholder('Publisher A, Publisher B')
					component.setValue(this.settings.filteredPublishers ?? '')
					component.onChange(async (value) => {
						this.settings.filteredPublishers = value
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

		new Setting(containerEl).setName('Instapaper (optional)').setHeading()

		new Setting(containerEl)
			.setName('Instapaper consumer key')
			.setDesc('OAuth consumer key from your Instapaper API application')
			.addText((component) => {
				component.setValue(this.settings.instapaperConsumerKey ?? '')
				component.onChange(async (value) => {
					this.settings.instapaperConsumerKey = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		new Setting(containerEl)
			.setName('Instapaper consumer secret')
			.addText((component) => {
				component.setValue(this.settings.instapaperConsumerSecret ?? '')
				component.onChange(async (value) => {
					this.settings.instapaperConsumerSecret = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		new Setting(containerEl)
			.setName('Instapaper username')
			.addText((component) => {
				component.setValue(this.settings.instapaperUsername ?? '')
				component.onChange(async (value) => {
					this.settings.instapaperUsername = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		new Setting(containerEl)
			.setName('Instapaper password')
			.addText((component) => {
				component.inputEl.type = 'password'
				component.setValue(this.settings.instapaperPassword ?? '')
				component.onChange(async (value) => {
					this.settings.instapaperPassword = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		new Setting(containerEl)
			.setName('Instapaper bookmark limit')
			.setDesc('Maximum number of unread Instapaper bookmarks to include when generating ePub')
			.addSlider((slider) => {
				slider
					.setLimits(5, 100, 5)
					.setValue(this.settings.instapaperLimit ?? 25)
					.setDynamicTooltip()
					.setInstant(true)
					.onChange(async (value) => {
						this.settings.instapaperLimit = value;
						await this.plugin.saveSettings(this.settings);
					});
			});

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
