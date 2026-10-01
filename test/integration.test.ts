import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { InstapaperClient } from '../instapaper';
import { requestUrl } from 'obsidian';

function loadDotEnv() {
	const envPath = path.resolve(process.cwd(), '.env');
	if (!fs.existsSync(envPath)) return;
	const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let value = trimmed.slice(eqIdx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (!process.env[key] && value) {
			process.env[key] = value;
		}
	}
}

async function runTests() {
	loadDotEnv();

	const instapaperToken = process.env.INSTAPAPER_ACCESS_TOKEN?.trim();
	const feedlyToken = process.env.FEEDLY_ACCESS_TOKEN?.trim();
	const feedlyUserId = process.env.FEEDLY_USER_ID?.trim();

	if (!instapaperToken && !feedlyToken) {
		console.error(
			'No access tokens found. Copy .env.example to .env and set INSTAPAPER_ACCESS_TOKEN and/or FEEDLY_ACCESS_TOKEN.'
		);
		process.exit(1);
	}

	let passed = 0;
	let failed = 0;

	async function test(name: string, fn: () => Promise<void>) {
		try {
			await fn();
			console.log(`✓ ${name}`);
			passed++;
		} catch (err) {
			console.error(`✗ ${name}`);
			console.error(err);
			failed++;
		}
	}

	if (instapaperToken) {
		const client = new InstapaperClient(instapaperToken);
		let sampleBookmarkId: number | undefined;

		await test('Instapaper API v2: getFolders() returns valid folders array', async () => {
			const folders = await client.getFolders();
			assert.ok(Array.isArray(folders), 'Expected folders to be an array');
			for (const folder of folders) {
				assert.strictEqual(typeof folder.id, 'number', 'Folder id should be a number');
				assert.strictEqual(typeof folder.title, 'string', 'Folder title should be a string');
				assert.ok(folder.title.length > 0, 'Folder title should be non-empty');
			}
		});

		await test('Instapaper API v2: getBookmarks() returns valid bookmark list', async () => {
			const list = await client.getBookmarks(5, undefined, 0);
			assert.ok(list && typeof list === 'object', 'Expected response object');
			assert.ok(Array.isArray(list.bookmarks), 'Expected bookmarks array');
			assert.strictEqual(typeof list.total, 'number', 'Expected numeric total count');

			if (list.bookmarks.length > 0) {
				const first = list.bookmarks[0];
				assert.strictEqual(typeof first.id, 'number', 'Bookmark id should be a number');
				assert.strictEqual(typeof first.time, 'number', 'Bookmark time should be a Unix timestamp');
				sampleBookmarkId = first.id;
			}
		});

		await test('Instapaper API v2: getText() returns parsed HTML content for a bookmark', async () => {
			assert.ok(sampleBookmarkId !== undefined, 'Expected at least one bookmark in account to test getText()');
			const html = await client.getText(sampleBookmarkId!);
			assert.strictEqual(typeof html, 'string', 'Expected parsed HTML string from getText()');
			assert.ok(html!.length > 0, 'Expected non-empty HTML body from getText()');
		});
	} else {
		console.log('- Skipping Instapaper tests (INSTAPAPER_ACCESS_TOKEN not set)');
	}

	if (feedlyToken) {
		await test('Feedly API: /v3/tags returns valid boards list', async () => {
			const res = await requestUrl({
				url: 'https://cloud.feedly.com/v3/tags',
				method: 'GET',
				headers: {
					Authorization: `Bearer ${feedlyToken}`,
				},
			});
			assert.strictEqual(res.status, 200, 'Expected 200 OK from Feedly /v3/tags');
			assert.ok(Array.isArray(res.json), 'Expected array of Feedly tags/boards');
		});

		if (feedlyUserId) {
			await test('Feedly API: /v3/streams/contents returns valid stream items', async () => {
				const streamId = encodeURIComponent(`user/${feedlyUserId}/category/global.all`);
				const res = await requestUrl({
					url: `https://cloud.feedly.com/v3/streams/contents?streamId=${streamId}&count=5`,
					method: 'GET',
					headers: {
						Authorization: `Bearer ${feedlyToken}`,
					},
				});
				assert.strictEqual(res.status, 200, 'Expected 200 OK from Feedly stream');
				assert.ok(Array.isArray(res.json?.items), 'Expected items array in Feedly stream response');
			});
		}
	} else {
		console.log('- Skipping Feedly tests (FEEDLY_ACCESS_TOKEN not set)');
	}

	console.log(`\nTests finished: ${passed} passed, ${failed} failed.`);
	if (failed > 0) {
		process.exit(1);
	}
}

runTests();
