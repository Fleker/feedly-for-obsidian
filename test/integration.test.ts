import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { InstapaperClient } from '../instapaper';
import { cleanContent } from '../main';
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

	await test('HTML Parser (cleanContent): philly.html removes all tables, backgrounds/styles, and unclosed/block-wrapping links while preserving article text and inline links', async () => {
		const raw = fs.readFileSync(path.resolve(process.cwd(), 'philly.html'), 'utf8');
		const cleaned = cleanContent(raw);

		assert.strictEqual(
			(cleaned.match(/<\/?(table|tbody|thead|tfoot|tr|td|th)\b/gi) || []).length,
			0,
			'Expected no remaining table/tbody/tr/td tags in cleaned philly.html'
		);
		assert.strictEqual(
			(cleaned.match(/\b(style|bgcolor)\s*=/gi) || []).length,
			0,
			'Expected no remaining inline style or bgcolor attributes in cleaned philly.html'
		);
		assert.ok(!cleaned.includes('#D1E7F1'), 'Expected #D1E7F1 callout background color to be stripped');
		assert.ok(!cleaned.includes('And a glimpse of what summer has in store'), 'Expected display:none preheader to be stripped');
		assert.ok(!cleaned.includes('View on'), 'Expected "View on inquirer.com" header noise to be stripped');

		const openLinks = (cleaned.match(/<a\b[^>]*>/gi) || []).length;
		const closeLinks = (cleaned.match(/<\/a>/gi) || []).length;
		assert.strictEqual(openLinks, closeLinks, 'Expected balanced <a> and </a> tags in cleaned philly.html');
		assert.ok(openLinks > 0, 'Expected legitimate inline article links to be preserved');

		// Verify no <a> tag wraps block elements or spans across paragraphs
		const linkBlocks = cleaned.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
		for (const link of linkBlocks) {
			assert.ok(
				!/<\/?(div|p|table|ul|ol|li|blockquote|figcaption|h[1-6])\b/i.test(link),
				`Expected <a> tag not to wrap block elements: ${link.slice(0, 100)}`
			);
		}

		// Verify key article content is intact
		assert.ok(cleaned.includes('Good morning, Philly!'), 'Expected opening greeting to be preserved');
		assert.ok(cleaned.includes('Lifting up like-minded progressives'), 'Expected main story heading to be preserved');
		assert.ok(cleaned.includes('What’s affecting Philly temps this summer'), 'Expected weather story to be preserved');
		assert.ok(cleaned.includes('Pat Rakowski'), 'Expected reader story to be preserved');
	});

	await test('HTML Parser (cleanContent): moneystuff.html and patreon.html flatten deeply nested tables and strip all background colors and empty image links', async () => {
		for (const file of ['moneystuff.html', 'patreon.html']) {
			const raw = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
			const cleaned = cleanContent(raw);

			assert.strictEqual(
				(cleaned.match(/<\/?(table|tbody|thead|tfoot|tr|td|th)\b/gi) || []).length,
				0,
				`Expected no remaining table tags in ${file}`
			);
			assert.strictEqual(
				(cleaned.match(/\b(style|bgcolor)\s*=/gi) || []).length,
				0,
				`Expected no remaining style or bgcolor attributes in ${file}`
			);
			assert.strictEqual(
				(cleaned.match(/<img\b/gi) || []).length,
				0,
				`Expected no remaining <img> tags in ${file}`
			);

			const openLinks = (cleaned.match(/<a\b[^>]*>/gi) || []).length;
			const closeLinks = (cleaned.match(/<\/a>/gi) || []).length;
			assert.strictEqual(openLinks, closeLinks, `Expected balanced <a> and </a> tags in ${file}`);
		}

		const cleanedMoneyStuff = cleanContent(fs.readFileSync(path.resolve(process.cwd(), 'moneystuff.html'), 'utf8'));
		assert.ok(!cleanedMoneyStuff.includes('View in browser'), 'Expected "View in browser" link to be removed from moneystuff.html');
		assert.ok(cleanedMoneyStuff.includes('Index demand'), 'Expected section heading in moneystuff.html');
		assert.ok(cleanedMoneyStuff.includes('Universal/Pershing'), 'Expected second section heading in moneystuff.html');

		const cleanedPatreon = cleanContent(fs.readFileSync(path.resolve(process.cwd(), 'patreon.html'), 'utf8'));
		assert.ok(!cleanedPatreon.includes('View in app'), 'Expected "View in app" link to be removed from patreon.html');
		assert.ok(cleanedPatreon.includes('Chicago GO Fest Raid Train'), 'Expected post title in patreon.html');
		assert.ok(cleanedPatreon.includes('Art Institute of Chicago'), 'Expected post body in patreon.html');
	});

	await test('HTML Parser (cleanContent): noahpinion.html unwraps embedded tweets, post cards, and heading/non-blue links while preserving inline links and full article text', async () => {
		const raw = fs.readFileSync(path.resolve(process.cwd(), 'noahpinion.html'), 'utf8');
		const cleaned = cleanContent(raw);

		assert.strictEqual(
			(cleaned.match(/<\/?(table|tbody|thead|tfoot|tr|td|th|picture|source|svg)\b/gi) || []).length,
			0,
			'Expected no remaining table, picture, source, or svg tags in cleaned noahpinion.html'
		);
		assert.strictEqual(
			(cleaned.match(/\b(style|bgcolor)\s*=/gi) || []).length,
			0,
			'Expected no remaining inline style or bgcolor attributes in cleaned noahpinion.html'
		);
		assert.strictEqual(
			(cleaned.match(/<img\b/gi) || []).length,
			0,
			'Expected no remaining <img> tags in cleaned noahpinion.html'
		);

		const openLinks = (cleaned.match(/<a\b[^>]*>/gi) || []).length;
		const closeLinks = (cleaned.match(/<\/a>/gi) || []).length;
		assert.strictEqual(openLinks, closeLinks, 'Expected balanced <a> and </a> tags in cleaned noahpinion.html');
		assert.ok(openLinks >= 35, `Expected inline article links to be preserved (found ${openLinks})`);

		// Verify embedded tweet (Jason Furman), embedded Substack card, and article title are NOT wrapped in <a> tags
		const linkBlocks = cleaned.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
		for (const link of linkBlocks) {
			assert.ok(
				!/<\/?(div|p|table|ul|ol|li|blockquote|figcaption|h[1-6])\b/i.test(link),
				`Expected <a> tag not to wrap block elements in noahpinion.html: ${link.slice(0, 100)}`
			);
			assert.ok(
				!link.includes('Jason Furman'),
				'Expected embedded tweet not to remain wrapped in a link that turns it blue'
			);
			assert.ok(
				!link.includes('One More Reason Americans Hate AI'),
				'Expected embedded Substack card title not to remain wrapped in a blue link'
			);
		}

		// Verify key article content and embedded tweet text are preserved
		assert.ok(cleaned.includes('What the AI boom is doing for Americans'), 'Expected article title to be preserved');
		assert.ok(cleaned.includes('Paul Krugman is the greatest econ writer in the world'), 'Expected opening paragraph to be preserved');
		assert.ok(cleaned.includes('Jason Furman'), 'Expected embedded tweet author to be preserved');
		assert.ok(cleaned.includes('Investment in information processing equipment'), 'Expected embedded tweet body to be preserved');
		assert.ok(cleaned.includes('an IT-driven productivity boom</a>'), 'Expected legitimate inline link to remain intact');
	});

	await test('HTML Parser (cleanContent): nyfocus.html (Mamdani and Unions) removes all odd backgrounds, light text styles, tables, and hidden bot links while preserving article text', async () => {
		const raw = fs.readFileSync(path.resolve(process.cwd(), 'nyfocus.html'), 'utf8');
		const cleaned = cleanContent(raw);

		assert.strictEqual(
			(cleaned.match(/<\/?(table|tbody|thead|tfoot|tr|td|th|center)\b/gi) || []).length,
			0,
			'Expected no remaining table or center tags in cleaned nyfocus.html'
		);
		assert.strictEqual(
			(cleaned.match(/\b(style|bgcolor)\s*=/gi) || []).length,
			0,
			'Expected no remaining style or bgcolor attributes in cleaned nyfocus.html'
		);
		assert.ok(!cleaned.includes('#0c2329'), 'Expected dark #0c2329 background color to be stripped');
		assert.ok(!cleaned.includes('#f8bd47'), 'Expected yellow #f8bd47 background color to be stripped');
		assert.ok(!cleaned.includes('background-color:#237190'), 'Expected blue #237190 background color to be stripped');
		assert.ok(!cleaned.includes('244, 244, 244'), 'Expected light rgb(244, 244, 244) text color to be stripped');
		assert.ok(!cleaned.includes('Click this link if you are a bot'), 'Expected font-size:0 bot honeypot links to be stripped');
		assert.ok(!cleaned.includes('View Email in Your Browser'), 'Expected "View Email in Your Browser" header link to be stripped');

		const openLinks = (cleaned.match(/<a\b[^>]*>/gi) || []).length;
		const closeLinks = (cleaned.match(/<\/a>/gi) || []).length;
		assert.strictEqual(openLinks, closeLinks, 'Expected balanced <a> and </a> tags in cleaned nyfocus.html');
		assert.ok(openLinks > 0, 'Expected legitimate inline links to be preserved in nyfocus.html');

		// Verify key Mamdani & Unions article content is preserved
		assert.ok(
			cleaned.includes('EXCLUSIVE: Mamdani Enlists Unions in Push to Overhaul NYC Hiring'),
			'Expected Mamdani & Unions headline to be preserved'
		);
		assert.ok(
			cleaned.includes('Mayor Zohran Mamdani plans to take a swing at one of New York City’s most intractable problems'),
			'Expected Mamdani & Unions lead paragraph to be preserved'
		);
		assert.ok(
			cleaned.includes('12-person group of city officials and labor leaders'),
			'Expected Mamdani & Unions body paragraph to be preserved'
		);
	});

	await test('HTML Parser (cleanContent): unwraps <a> tags wrapping block content or left unclosed by ad blocks', async () => {
		const brokenAdHtml = `
			<div data-block="top-ad"><div>Advertisement</div><a href="https://ad.doubleclick.net/track"><div>Sponsored</div></div>
			<table bgcolor="#D1E7F1"><tbody style="background:#eee"><tr style='background-color: #123456'><td bgcolor='#ff0'>
				<p style="background-color: #EFF1F4;">Paragraph inside table and unclosed ad link with <a href="https://example.com/story">inline link</a>.</p>
			</td></tr></tbody></table></a>
			<a href="https://example.com/card"><div style="color:#000"><p>Card paragraph that would otherwise turn all blue</p></div></a>
		`;
		const cleaned = cleanContent(brokenAdHtml);

		assert.strictEqual((cleaned.match(/<\/?(table|tbody|tr|td)\b/gi) || []).length, 0, 'Expected tables to be flattened');
		assert.strictEqual((cleaned.match(/\b(style|bgcolor)\s*=/gi) || []).length, 0, 'Expected all style and bgcolor attributes to be removed');
		assert.strictEqual((cleaned.match(/<a\b[^>]*>/gi) || []).length, 1, 'Expected only the 1 valid inline link to remain');
		assert.strictEqual((cleaned.match(/<\/a>/gi) || []).length, 1, 'Expected only 1 closing </a> tag to remain');
		assert.ok(cleaned.includes('<a href="https://example.com/story">inline link</a>'), 'Expected valid inline link to remain intact');
		assert.ok(cleaned.includes('<p>Card paragraph that would otherwise turn all blue</p>'), 'Expected unwrapped card paragraph content to remain intact');
	});

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
				sampleBookmark = list.bookmarks.find((b) => b.author && b.pubtime) ?? first;
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
			await test('Feedly API: /v3/streams/contents returns valid stream items and cleanContent sanitizes their HTML', async () => {
				const streamId = encodeURIComponent(`user/${feedlyUserId}/category/global.all`);
				const res = await requestUrl({
					url: `https://cloud.feedly.com/v3/streams/contents?streamId=${streamId}&count=10`,
					method: 'GET',
					headers: {
						Authorization: `Bearer ${feedlyToken}`,
					},
				});
				assert.strictEqual(res.status, 200, 'Expected 200 OK from Feedly stream');
				assert.ok(Array.isArray(res.json?.items), 'Expected items array in Feedly stream response');

				for (const item of res.json.items) {
					const html = item?.content?.content || item?.summary?.content || item?.fullContent;
					if (!html) continue;
					const cleaned = cleanContent(html);
					assert.strictEqual(
						(cleaned.match(/<\/?(table|tbody|thead|tfoot|tr|td|th)\b/gi) || []).length,
						0,
						`Expected no remaining table tags in cleaned Feedly article "${item.title}"`
					);
					assert.strictEqual(
						(cleaned.match(/\b(style|bgcolor)\s*=/gi) || []).length,
						0,
						`Expected no remaining inline style or bgcolor attributes in cleaned Feedly article "${item.title}"`
					);
					const openLinks = (cleaned.match(/<a\b[^>]*>/gi) || []).length;
					const closeLinks = (cleaned.match(/<\/a>/gi) || []).length;
					assert.strictEqual(
						openLinks,
						closeLinks,
						`Expected balanced <a> and </a> tags in cleaned Feedly article "${item.title}"`
					);
				}
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
