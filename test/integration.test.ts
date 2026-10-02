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
		let sampleBookmark: Awaited<ReturnType<typeof client.getBookmarks>>['bookmarks'][number] | undefined;

		await test('Instapaper API v2: getFolders() returns valid folders array', async () => {
			const folders = await client.getFolders();
			assert.ok(Array.isArray(folders), 'Expected folders to be an array');
			for (const folder of folders) {
				assert.strictEqual(typeof folder.id, 'number', 'Folder id should be a number');
				assert.strictEqual(typeof folder.title, 'string', 'Folder title should be a string');
				assert.ok(folder.title.length > 0, 'Folder title should be non-empty');
			}
		});

		await test('Instapaper API v2: getBookmarks() returns valid bookmark list with author and pubtime fields', async () => {
			const list = await client.getBookmarks(5, undefined, 0);
			assert.ok(list && typeof list === 'object', 'Expected response object');
			assert.ok(Array.isArray(list.bookmarks), 'Expected bookmarks array');
			assert.strictEqual(typeof list.total, 'number', 'Expected numeric total count');

			if (list.bookmarks.length > 0) {
				const first = list.bookmarks[0];
				assert.strictEqual(typeof first.id, 'number', 'Bookmark id should be a number');
				assert.strictEqual(typeof first.time, 'number', 'Bookmark time should be a Unix timestamp');
				assert.ok(
					typeof first.author === 'string' || first.author === null,
					'Bookmark author should be a string or null'
				);
				assert.ok(
					typeof first.pubtime === 'number' || first.pubtime === null,
					'Bookmark pubtime should be a Unix timestamp or null'
				);
				sampleBookmark = first;
			}
		});

		await test('Instapaper API v2: parseBookmark() and getText() return parsed metadata (author, pubtime) and HTML content', async () => {
			assert.ok(sampleBookmark !== undefined, 'Expected at least one bookmark in account to test parseBookmark()');
			const parsed = await client.parseBookmark(sampleBookmark!.id);
			assert.ok(parsed && typeof parsed === 'object', 'Expected parsed result object');
			assert.ok(parsed.metadata && typeof parsed.metadata === 'object', 'Expected metadata object in parsed result');
			assert.ok(
				parsed.metadata.author === null || typeof parsed.metadata.author?.name === 'string',
				'Expected metadata.author to be null or an object with a string name'
			);
			assert.ok(
				typeof parsed.metadata.pubtime === 'number' || parsed.metadata.pubtime === null,
				'Expected metadata.pubtime to be a Unix timestamp or null'
			);

			const resolvedAuthor = sampleBookmark!.author ?? parsed.metadata.author?.name;
			const resolvedPubtime = sampleBookmark!.pubtime ?? parsed.metadata.pubtime;
			assert.ok(
				typeof resolvedAuthor === 'string' && resolvedAuthor.length > 0,
				`Expected non-empty resolved author (got: ${resolvedAuthor})`
			);
			assert.ok(
				typeof resolvedPubtime === 'number' && resolvedPubtime > 0,
				`Expected positive Unix timestamp for resolved pubtime (got: ${resolvedPubtime})`
			);

			assert.strictEqual(typeof parsed.content?.body, 'string', 'Expected parsed HTML string in content.body');
			assert.ok(parsed.content.body!.length > 0, 'Expected non-empty HTML body from parseBookmark()');

			const html = await client.getText(sampleBookmark!.id);
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
