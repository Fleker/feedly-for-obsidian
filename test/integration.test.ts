import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { InstapaperClient } from '../instapaper';
import { cleanContent, formatInstapaperArticle, isMediumDailyDigest, groupArticlesForEpub, FeedlyArticle } from '../main';
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
		assert.ok(!cleaned.includes('If someone forwarded you this email'), 'Expected forwarded-email signup banner to be stripped');
		assert.ok(!cleaned.includes('By submitting your written, visual'), 'Expected legal submission disclaimer to be stripped');
		assert.ok(!cleaned.includes('Download Our App'), 'Expected app download prompt to be stripped');
		assert.ok(!cleaned.includes('100 S. Independence Mall West'), 'Expected corporate mailing address to be stripped');
		assert.ok(!cleaned.includes('Unsubscribe'), 'Expected Unsubscribe footer link to be stripped');

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
		assert.ok(cleaned.includes('Have a great day.'), 'Expected closing sign-off to be preserved');
	});

	await test('HTML Parser (cleanContent): moneystuff.html and patreon.html flatten deeply nested tables and strip all background colors, footers, and action buttons while preserving footnotes', async () => {
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
		assert.ok(!cleanedMoneyStuff.includes("If you'd like to get Money Stuff in handy email form"), 'Expected newsletter signup banner to be stripped from moneystuff.html');
		assert.ok(!cleanedMoneyStuff.includes('Follow Us'), 'Expected "Follow Us" footer to be stripped from moneystuff.html');
		assert.ok(!cleanedMoneyStuff.includes('Get the newsletter'), 'Expected "Get the newsletter" footer to be stripped from moneystuff.html');
		assert.ok(!cleanedMoneyStuff.includes('Bloomberg L.P. 731 Lexington'), 'Expected corporate mailing address to be stripped from moneystuff.html');
		assert.ok(!cleanedMoneyStuff.includes('Unsubscribe'), 'Expected Unsubscribe link to be stripped from moneystuff.html');
		assert.ok(cleanedMoneyStuff.includes('Index demand'), 'Expected section heading in moneystuff.html');
		assert.ok(cleanedMoneyStuff.includes('Universal/Pershing'), 'Expected second section heading in moneystuff.html');
		assert.ok(cleanedMoneyStuff.includes('Especially in my email inbox.'), 'Expected footnote [1] to be preserved in moneystuff.html');
		assert.ok(cleanedMoneyStuff.includes('I originally wrote'), 'Expected footnote [2] to be preserved in moneystuff.html');

		const cleanedPatreon = cleanContent(fs.readFileSync(path.resolve(process.cwd(), 'patreon.html'), 'utf8'));
		assert.ok(!cleanedPatreon.includes('View in app'), 'Expected "View in app" link to be removed from patreon.html');
		assert.ok(!cleanedPatreon.includes('View page'), 'Expected "View page" CTA button to be removed from patreon.html');
		assert.ok(!cleanedPatreon.includes('Did you like this post?'), 'Expected "Did you like this post?" prompt to be removed from patreon.html');
		assert.ok(!cleanedPatreon.includes('600 Townsend Street'), 'Expected Patreon corporate mailing address to be removed from patreon.html');
		assert.ok(!cleanedPatreon.includes('Manage your email settings'), 'Expected email settings footer link to be removed from patreon.html');
		assert.ok(cleanedPatreon.includes('Chicago GO Fest Raid Train'), 'Expected post title in patreon.html');
		assert.ok(cleanedPatreon.includes('Art Institute of Chicago'), 'Expected post body in patreon.html');
	});

	await test('HTML Parser (cleanContent): noahpinion.html unwraps embedded tweets, post cards, and heading/non-blue links while stripping Substack chrome and preserving inline links and footnotes', async () => {
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

		// Verify Substack header/footer chrome and engagement buttons are stripped
		assert.ok(!cleaned.includes('Forwarded this email?'), 'Expected "Forwarded this email?" top banner to be stripped');
		assert.ok(!cleaned.includes('READ IN APP'), 'Expected "READ IN APP" button to be stripped');
		assert.ok(!cleaned.includes('Subscribed'), 'Expected "Subscribed" button to be stripped');
		assert.ok(!cleaned.includes('Restack'), 'Expected "Restack" action button to be stripped');
		assert.ok(!cleaned.includes('548 Market Street'), 'Expected Substack 548 Market Street mailing address to be stripped');
		assert.ok(!cleaned.includes('Unsubscribe'), 'Expected Substack Unsubscribe footer to be stripped');

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

		// Verify key article content, embedded tweet text, and footnote 1 are preserved
		assert.ok(cleaned.includes('What the AI boom is doing for Americans'), 'Expected article title to be preserved');
		assert.ok(cleaned.includes('Paul Krugman is the greatest econ writer in the world'), 'Expected opening paragraph to be preserved');
		assert.ok(cleaned.includes('Jason Furman'), 'Expected embedded tweet author to be preserved');
		assert.ok(cleaned.includes('Investment in information processing equipment'), 'Expected embedded tweet body to be preserved');
		assert.ok(cleaned.includes('an IT-driven productivity boom</a>'), 'Expected legitimate inline link to remain intact');
		assert.ok(cleaned.includes('I’m kind of annoyed by the use of'), 'Expected footnote 1 at end of noahpinion.html to be preserved');
	});

	await test('HTML Parser (cleanContent): nyfocus.html (Mamdani and Unions) removes all odd backgrounds, light text styles, tables, CTA buttons, and Mailchimp footer while preserving article text', async () => {
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
		assert.ok(!cleaned.includes('READ IN NEW YORK FOCUS'), 'Expected "READ IN NEW YORK FOCUS" CTA button to be stripped');
		assert.ok(!cleaned.includes('SUPPORT NEW YORK JOURNALISM'), 'Expected "SUPPORT NEW YORK JOURNALISM" CTA button to be stripped');
		assert.ok(!cleaned.includes('This email was sent to'), 'Expected Mailchimp recipient footer to be stripped');
		assert.ok(!cleaned.includes('Copyright © New York Focus'), 'Expected copyright notice to be stripped');
		assert.ok(!cleaned.includes('178 Columbus Ave #237190'), 'Expected NY Focus mailing address to be stripped');

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

	await test('HTML Parser (cleanContent): unwraps <a> tags wrapping block content and strips Substack RSS editor labels and subscribe widgets', async () => {
		const brokenAdHtml = `
			<div data-block="top-ad"><div>Advertisement</div><a href="https://ad.doubleclick.net/track"><div>Sponsored</div></div>
			<table bgcolor="#D1E7F1"><tbody style="background:#eee"><tr style='background-color: #123456'><td bgcolor='#ff0'>
				<p style="background-color: #EFF1F4;">Paragraph inside table and unclosed ad link with <a href="https://example.com/story">inline link</a>.</p>
			</td></tr></tbody></table></a>
			<a href="https://example.com/card"><div style="color:#000"><p>Card paragraph that would otherwise turn all blue</p></div></a>
			<label contenteditable="false">Text within this block will maintain its original spacing when published</label>
			<pre>Poetry or code block content</pre>
			<p class="button-wrapper" data-component-name="ButtonCreateButton"><a class="button primary" href="https://example.substack.com/subscribe"><span>Subscribe now</span></a></p>
			<div class="subscription-widget-wrap-editor" data-component-name="SubscribeWidgetToDOM"><div class="subscription-widget show-subscribe"><div class="preamble"><p class="cta-caption">Thanks for reading Example Substack! Subscribe for free to receive new posts.</p></div></div></div>
		`;
		const cleaned = cleanContent(brokenAdHtml);

		assert.strictEqual((cleaned.match(/<\/?(table|tbody|tr|td)\b/gi) || []).length, 0, 'Expected tables to be flattened');
		assert.strictEqual((cleaned.match(/\b(style|bgcolor)\s*=/gi) || []).length, 0, 'Expected all style and bgcolor attributes to be removed');
		assert.strictEqual((cleaned.match(/<a\b[^>]*>/gi) || []).length, 1, 'Expected only the 1 valid inline link to remain');
		assert.strictEqual((cleaned.match(/<\/a>/gi) || []).length, 1, 'Expected only 1 closing </a> tag to remain');
		assert.ok(cleaned.includes('<a href="https://example.com/story">inline link</a>'), 'Expected valid inline link to remain intact');
		assert.ok(cleaned.includes('<p>Card paragraph that would otherwise turn all blue</p>'), 'Expected unwrapped card paragraph content to remain intact');
		assert.ok(cleaned.includes('<pre>Poetry or code block content</pre>'), 'Expected <pre> block content to remain intact');
		assert.ok(!cleaned.includes('Text within this block will maintain its original spacing when published'), 'Expected Substack <pre> editor label to be stripped');
		assert.ok(!cleaned.includes('Subscribe now'), 'Expected Substack ButtonCreateButton CTA to be stripped');
		assert.ok(!cleaned.includes('SubscribeWidgetToDOM'), 'Expected Substack SubscribeWidgetToDOM block to be stripped');
		assert.ok(!cleaned.includes('Thanks for reading Example Substack!'), 'Expected Substack subscribe widget preamble to be stripped');
	});

	await test('HTML Parser (cleanContent): strips embedded <style> and <link rel="stylesheet"> tags, and Medium Daily Digest footer and preference links', async () => {
		const mediumHtml = `
			<style type="text/css">
				body, table, td, div { height: 100% !important; }
				.story-card { page-break-after: always; break-after: page; }
			</style>
			<link rel="stylesheet" href="https://medium.com/email.css">
			<div class="story-card">
				<p>First recommended story snippet from Medium.</p>
			</div>
			<div class="story-card">
				<p>Second recommended story snippet with an <a href="https://medium.com/story-2">article link</a>.</p>
			</div>
			<p>You received this email because you opted into the Medium Daily Digest. Adjust your digest preferences</p>
			<p>Medium, 548 Market St, PMB 42061, San Francisco, CA 94104</p>
		`;
		const cleaned = cleanContent(mediumHtml);

		assert.strictEqual((cleaned.match(/<\/?style\b/gi) || []).length, 0, 'Expected no <style> tags in cleaned HTML');
		assert.strictEqual((cleaned.match(/<\/?link\b/gi) || []).length, 0, 'Expected no <link> tags in cleaned HTML');
		assert.ok(!cleaned.includes('height: 100%'), 'Expected embedded CSS height rule to be stripped');
		assert.ok(!cleaned.includes('page-break-after'), 'Expected embedded CSS page-break rule to be stripped');
		assert.ok(!cleaned.includes('You received this email because you opted into the Medium Daily Digest'), 'Expected Medium subscription notice to be stripped');
		assert.ok(!cleaned.includes('Adjust your digest preferences'), 'Expected Medium digest preferences prompt to be stripped');
		assert.ok(!cleaned.includes('548 Market St'), 'Expected Medium 548 Market St address to be stripped');
		assert.ok(cleaned.includes('First recommended story snippet from Medium.'), 'Expected first story text to be preserved');
		assert.ok(cleaned.includes('Second recommended story snippet with an <a href="https://medium.com/story-2">article link</a>.'), 'Expected second story text and inline link to be preserved');
	});

	await test('HTML Parser (cleanContent): Medium Daily Digest entity demotes internal h1 and h2 story titles to h3 to avoid e-reader page breaks', async () => {
		const digestHtml = `
			<h2>Story 1: Understanding Concurrency in Go</h2>
			<p>Deep dive into Go routines and channels.</p>
			<h2>Story 2: Microservices at Scale</h2>
			<p>Lessons learned operating distributed systems.</p>
			<h1>Bonus Spotlight: Observability 101</h1>
			<p>Tracing and metrics in production.</p>
		`;
		const cleaned = cleanContent(digestHtml);

		assert.strictEqual(
			(cleaned.match(/<\/?h[12]\b/gi) || []).length,
			0,
			'Expected all h1 and h2 tags to be demoted to avoid chapter/page breaks'
		);
		assert.strictEqual(
			(cleaned.match(/<h3\b/gi) || []).length,
			3,
			'Expected all 3 story titles to be converted to h3 headings'
		);
		assert.ok(cleaned.includes('<h3>Story 1: Understanding Concurrency in Go</h3>'));
		assert.ok(cleaned.includes('<h3>Story 2: Microservices at Scale</h3>'));
		assert.ok(cleaned.includes('<h3>Bonus Spotlight: Observability 101</h3>'));
	});

	await test('EPUB Digest Grouping: isMediumDailyDigest accurately identifies digest articles', async () => {
		assert.strictEqual(
			isMediumDailyDigest({ id: '1', title: 'Story 1', origin: { title: 'Medium Daily Digest' } }),
			true,
			'Expected origin "Medium Daily Digest" to be recognized'
		);
		assert.strictEqual(
			isMediumDailyDigest({ id: '2', title: 'Medium Daily Digest: May 15', origin: { title: 'Medium' } }),
			true,
			'Expected title containing "Medium Daily Digest" to be recognized'
		);
		assert.strictEqual(
			isMediumDailyDigest({ id: '3', title: 'Why AI Matters', origin: { title: 'Medium' } }),
			false,
			'Regular Medium article should not be classified as daily digest'
		);
		assert.strictEqual(
			isMediumDailyDigest({ id: '4', title: 'Tech Review', origin: { title: 'The Verge' } }),
			false,
			'Third-party article should not be classified as daily digest'
		);
	});

	await test('EPUB Digest Grouping: groupArticlesForEpub combines multiple Medium Daily Digest articles into a single flowing section and preserves non-digest sections', async () => {
		const articles: FeedlyArticle[] = [
			{
				id: 'verge-1',
				title: 'New Gadget Released',
				canonicalUrl: 'https://theverge.com/gadget',
				origin: { title: 'The Verge' },
				published: 1700000000000,
				content: { content: '<p>Verge gadget review content.</p>' },
			},
			{
				id: 'medium-1',
				title: 'Understanding Async Runtimes',
				canonicalUrl: 'https://medium.com/story-1',
				author: 'Jane Doe',
				origin: { title: 'Medium Daily Digest' },
				published: 1700000001000,
				content: { content: '<p>First Medium digest story body.</p>' },
			},
			{
				id: 'ars-1',
				title: 'Science Breakthrough',
				canonicalUrl: 'https://arstechnica.com/science',
				origin: { title: 'Ars Technica' },
				published: 1700000002000,
				content: { content: '<p>Ars Technica science article.</p>' },
			},
			{
				id: 'medium-2',
				title: 'Designing with Micro-Frontends',
				canonicalUrl: 'https://medium.com/story-2',
				author: 'John Smith',
				origin: { title: 'Medium Daily Digest' },
				published: 1700000003000,
				content: { content: '<p>Second Medium digest story body.</p>' },
			},
		];

		const sections = groupArticlesForEpub(articles);

		// 4 articles input: 2 regular + 2 digest -> 3 sections output (Verge, Grouped Medium Digest, Ars Technica)
		assert.strictEqual(sections.length, 3, 'Expected 3 sections after grouping digest articles');
		assert.strictEqual(sections[0].title, 'New Gadget Released', 'First section should be The Verge article');
		assert.strictEqual(sections[1].title, 'Medium Daily Digest', 'Second section should be the grouped Medium Daily Digest');
		assert.strictEqual(sections[2].title, 'Science Breakthrough', 'Third section should be the Ars Technica article');

		// Verify grouped section contains both stories flowing sequentially
		const digestData = sections[1].data;
		assert.ok(digestData.includes('Understanding Async Runtimes'), 'Expected first digest title in grouped section');
		assert.ok(digestData.includes('First Medium digest story body.'), 'Expected first digest content in grouped section');
		assert.ok(digestData.includes('Designing with Micro-Frontends'), 'Expected second digest title in grouped section');
		assert.ok(digestData.includes('Second Medium digest story body.'), 'Expected second digest content in grouped section');
		assert.ok(digestData.includes('class="digest-article"'), 'Expected digest-article wrapper in grouped section');
		assert.ok(digestData.includes('<hr/>'), 'Expected divider between digest articles in grouped section');

		// Verify single digest article case (does not create empty or duplicate sections)
		const singleDigestSections = groupArticlesForEpub([articles[1]]);
		assert.strictEqual(singleDigestSections.length, 1, 'Expected 1 section for single digest article');
		assert.strictEqual(singleDigestSections[0].title, 'Understanding Async Runtimes');
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

			const formatted = formatInstapaperArticle(sampleBookmark!, parsed);
			assert.ok(formatted !== null, 'Expected formatInstapaperArticle() to produce non-null EPUB section');
			assert.strictEqual(
				(formatted!.data.match(/<\/?(?:html|body|section|article|main|header|footer|aside|nav|figure|figcaption|fig|table|img|h1)\b/gi) || []).length,
				0,
				'Expected formatted Instapaper section to strip document/section/figure/table/img/h1 tags that cause EPUB page breaks'
			);
			assert.strictEqual(
				(formatted!.data.match(/<h2\b/gi) || []).length,
				1,
				'Expected only the single top-level <h2> article header in formatted Instapaper section'
			);
		});
	} else {
		console.log('- Skipping Instapaper tests (INSTAPAPER_ACCESS_TOKEN not set)');
	}

	await test('Instapaper EPUB Output (formatInstapaperArticle & cleanContent): sanitizes Instapaper HTML wrappers, sectioning tags, h1/h2 headings, classless figures, templates, and XML metadata', async () => {
		const instapaperParsedHtml = `<html><body>
			<main>
				<section>
					<header><h1>Building on ATProto</h1></header>
					<p>Opening paragraph from an Instapaper-parsed essay.</p>
					<figure><blockquote><p>“When I look at the towers, all I feel is a hundred thousand eyes on my back.”</p></blockquote></figure>
				</section>
				<section>
					<header><h2><span>Part I: </span>The Commanding Heights</h2></header>
					<figure><a href="https://example.com/img/chart.jpg"><picture><source/><img src="https://example.com/img/chart-700.jpg"/></picture></a><figcaption><span>Standard Oil’s trunk pipelines, 1906.</span></figcaption></figure>
					<figure><div><div><img src="https://example.com/img/photo.png"/></div></div><figcaption><div>Sophie Green</div><div>Caption with block divs inside figcaption.</div></figcaption></figure>
					<fig><p><b>FIG 1.</b> Architecture diagram from IEEE paper.</p></fig>
					<p>Body text following figures and subheadings.</p>
					<template><div>Hidden YouTube subscribe popup template</div></template>
				</section>
				<footer><h3>About the Author</h3><p>Author bio paragraph.</p></footer>
			</main>
		</body></html>`;

		const formatted = formatInstapaperArticle(
			{
				id: 2056985756,
				url: 'https://example.com/article?utm_source=substack&utm_medium=email',
				title: '<i>MCTC:</i> Building & Scaling on ATProto',
				description: null,
				image: null,
				progress: { percentage: 0, timestamp: 0 },
				liked: false,
				archived: false,
				time: 1700000000,
				pubtime: 1700003600,
				author: 'Jane & John: Editors',
				folder_id: null,
				tags: [],
				private_source: null,
				category: 0,
			},
			{
				metadata: {
					title: 'Building & Scaling on ATProto',
					author: { name: 'Jane & John: Editors', url: null },
					pubtime: 1700003600,
					thumbnail: null,
					description: null,
					private_source: null,
					category: 0,
				},
				content: {
					body: instapaperParsedHtml,
					images: [],
					words: 120,
					paywalled: false,
					direction: 'ltr',
				},
			}
		);

		assert.ok(formatted !== null, 'Expected formatted Instapaper section to be returned');
		assert.strictEqual(formatted!.title, 'MCTC: Building & Scaling on ATProto', 'Expected inline HTML tags stripped from TOC title');

		const data = formatted!.data;
		// Only the single outer <h2>${title}</h2> should exist; internal h1/h2 headings must be demoted to h3
		assert.strictEqual((data.match(/<h1\b/gi) || []).length, 0, 'Expected zero <h1> tags in formatted Instapaper output');
		assert.strictEqual((data.match(/<h2\b/gi) || []).length, 1, 'Expected only the 1 top-level <h2> article title');
		assert.ok(data.includes('<h3>Building on ATProto</h3>'), 'Expected internal <h1> to be demoted to <h3>');
		assert.ok(data.includes('<h3><span>Part I: </span>The Commanding Heights</h3>'), 'Expected internal <h2> to be demoted to <h3>');

		// Verify no nested html/body, HTML5 sectioning tags, figure/fig/figcaption, img, or template tags remain
		assert.strictEqual(
			(data.match(/<\/?(?:html|body|main|section|article|header|footer|aside|nav|figure|figcaption|fig|img|picture|source|template)\b/gi) || []).length,
			0,
			'Expected all document/sectioning/figure/image/template tags to be normalized or stripped'
		);

		// Verify classless pullquote, captions, and valid XHTML nesting (no <p><div>)
		assert.ok(
			data.includes('<blockquote><p>“When I look at the towers, all I feel is a hundred thousand eyes on my back.”</p></blockquote>'),
			'Expected classless Instapaper pullquote figure to be unwrapped cleanly'
		);
		assert.ok(data.includes('<p><span>Standard Oil’s trunk pipelines, 1906.</span></p>'), 'Expected linked-image figure caption to be preserved as <p>');
		assert.ok(!/<p\b[^>]*>\s*<div\b/i.test(data), 'Expected block-containing figcaption not to produce invalid <p><div> nesting');
		assert.ok(data.includes('Caption with block divs inside figcaption.'), 'Expected block-containing figcaption text to be preserved');
		assert.ok(data.includes('Architecture diagram from IEEE paper.'), 'Expected <fig> caption text to be preserved');
		assert.ok(!data.includes('Hidden YouTube subscribe popup template'), 'Expected <template> content to be stripped');

		// Verify XML escaping in frontmatter metadata and title
		assert.ok(data.includes('<h2>MCTC: Building &amp; Scaling on ATProto</h2>'), 'Expected escaped &amp; in <h2> header');
		assert.ok(data.includes('url: https://example.com/article?utm_source=substack&amp;utm_medium=email'), 'Expected escaped &amp; in frontmatter URL');
		assert.ok(data.includes('author: Jane &amp; John -  Editors'), 'Expected sanitized and XML-escaped author in frontmatter');

		// Verify empty/image-only Instapaper body returns null rather than rendering a blank page
		const emptyFormatted = formatInstapaperArticle(
			{
				id: 1,
				url: 'https://example.com/empty',
				title: 'Image Only',
				description: null,
				image: null,
				progress: { percentage: 0, timestamp: 0 },
				liked: false,
				archived: false,
				time: 1700000000,
				pubtime: null,
				author: null,
				folder_id: null,
				tags: [],
				private_source: null,
				category: 0,
			},
			{
				metadata: { title: 'Image Only', author: null, pubtime: null, thumbnail: null, description: null, private_source: null, category: 0 },
				content: { body: '<div><figure><img src="https://example.com/only.jpg"/></figure></div>', images: [], words: 0, paywalled: false, direction: null },
			}
		);
		assert.strictEqual(emptyFormatted, null, 'Expected image-only/empty Instapaper article to be skipped');
	});

	await test('HTML Parser (cleanContent): strips raw image URLs from quote-containing <img> attributes, auto-linked image URLs, bare image URLs, and escaped &lt;img&gt; tags while preserving article/PDF links', async () => {
		const rawImageLeakHtml = `
			<p>Lead paragraph before images.</p>
			<img alt="Chart: AI CapEx > Cloud Revenue" data-caption="Photo by <em>Jane Doe</em>" src="https://platform.theverge.com/wp-content/uploads/sites/2/2026/11/hero.jpg?quality=90" />
			<p><a href="https://substackcdn.com/image/fetch/w_1456,c_limit,f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fchart.png">https://substackcdn.com/image/fetch/w_1456,c_limit,f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fchart.png</a></p>
			<p><a href="https://preview.redd.it/xyz123.jpg?width=1080&amp;format=pjpg">https://preview.redd.it/xyz123.jpg?width=1080&amp;format=pjpg</a></p>
			<p>https://pbs.twimg.com/media/AbCdEfG?format=jpg&amp;name=large</p>
			<p>https://example.com/assets/diagram.webp</p>
			<p>&lt;img src="https://example.com/escaped-rss-image.png" alt="Escaped" /&gt;</p>
			<p><a href="/web/images/Issue14.jpg"><em>Caption wrapped in image link</em></a></p>
			<p>Read the <a href="https://example.com/uploads/report.pdf">full PDF report</a> or visit <a href="https://github.com/O-EDA/LightSim">https://github.com/O-EDA/LightSim</a>.</p>
		`;
		const cleaned = cleanContent(rawImageLeakHtml);

		assert.ok(!cleaned.includes('platform.theverge.com'), 'Expected <img> with ">" inside alt/data-caption not to leak trailing src="..." URL');
		assert.ok(!cleaned.includes('substackcdn.com/image/fetch'), 'Expected auto-linked Substack CDN image URL to be stripped');
		assert.ok(!cleaned.includes('preview.redd.it'), 'Expected auto-linked Reddit preview image URL to be stripped');
		assert.ok(!cleaned.includes('pbs.twimg.com/media'), 'Expected bare Twitter/X media image URL to be stripped');
		assert.ok(!cleaned.includes('diagram.webp'), 'Expected bare .webp image URL paragraph to be stripped');
		assert.ok(!cleaned.includes('escaped-rss-image.png'), 'Expected HTML-escaped &lt;img&gt; tag to be stripped');
		assert.ok(cleaned.includes('<p><em>Caption wrapped in image link</em></p>'), 'Expected caption text inside image-file href to be unwrapped and preserved');
		assert.ok(cleaned.includes('<a href="https://example.com/uploads/report.pdf">full PDF report</a>'), 'Expected non-image .pdf link to be preserved');
		assert.ok(cleaned.includes('<a href="https://github.com/O-EDA/LightSim">https://github.com/O-EDA/LightSim</a>'), 'Expected non-image GitHub URL link to be preserved');
	});

	await test('HTML Parser (cleanContent): verge_torrent.html strips CDATA, WordPress block classes, empty figures, and styles while preserving pullquotes and text', async () => {
		const raw = fs.readFileSync(path.resolve(process.cwd(), 'verge_torrent.html'), 'utf8');
		const cleaned = cleanContent(raw);

		assert.ok(!cleaned.includes('<![CDATA['), 'Expected CDATA start to be stripped');
		assert.ok(!cleaned.includes(']]>'), 'Expected CDATA end to be stripped');
		assert.strictEqual(
			(cleaned.match(/\b(style|bgcolor|background)\s*=/gi) || []).length,
			0,
			'Expected no remaining inline style, bgcolor, or background attributes in cleaned verge_torrent.html'
		);
		assert.strictEqual(
			(cleaned.match(/\b(?:wp-block-[a-z0-9-]+|has-[a-z0-9-]+)\b/gi) || []).length,
			0,
			'Expected no remaining Gutenberg/WordPress layout classes in cleaned verge_torrent.html'
		);
		assert.strictEqual(
			(cleaned.match(/<figure\b[^>]*>/gi) || []).length,
			0,
			'Expected no empty figure or pullquote figure containers in cleaned verge_torrent.html'
		);

		// Verify pullquotes were unwrapped to blockquotes
		assert.ok(
			cleaned.includes('<blockquote><p>“I am ethically conflicted about piracy. I often feel guilty about it.”</p></blockquote>'),
			'Expected pullquote to be unwrapped to clean blockquote'
		);

		// Verify key article content and links are preserved
		assert.ok(cleaned.includes('When Jane first heard about'), 'Expected article opening text to be preserved');
		assert.ok(cleaned.includes('http://www.mlfilms.com/productions/m_and_i'), 'Expected documentary link to be preserved');
		assert.ok(cleaned.includes('https://en.wikipedia.org/wiki/Lost_film'), 'Expected lost film link to be preserved');
		assert.ok(cleaned.includes('Marvin acknowledges'), 'Expected article ending text to be preserved');
	});

	await test('HTML Parser (cleanContent): johto.html strips inline styles and empty links while preserving extensive interview blockquotes and article text', async () => {
		const raw = fs.readFileSync(path.resolve(process.cwd(), 'johto.html'), 'utf8');
		const cleaned = cleanContent(raw);

		assert.strictEqual(
			(cleaned.match(/\b(style|bgcolor|background)\s*=/gi) || []).length,
			0,
			'Expected no remaining inline style, bgcolor, or background attributes in cleaned johto.html'
		);
		assert.strictEqual(
			(cleaned.match(/<a\b[^>]*>[\s\u200A-\u200D\uFEFF]*<\/a>/gi) || []).length,
			0,
			'Expected no empty <a> tags left from stripped <img> tags in cleaned johto.html'
		);

		// Verify blockquotes are preserved (the interview is formatted as blockquotes)
		const blockquoteCount = (cleaned.match(/<blockquote>/gi) || []).length;
		assert.ok(blockquoteCount >= 15, `Expected interview blockquotes to be preserved, found ${blockquoteCount}`);

		// Verify key article content is preserved
		assert.ok(cleaned.includes('A warm welcome to another issue of Johto Times!'), 'Expected opening greeting to be preserved');
		assert.ok(cleaned.includes('Katharina, the current webmaster of Bisafans'), 'Expected introduction to Katharina to be preserved');
		assert.ok(cleaned.includes('Bisaboard'), 'Expected forum references to be preserved');
		assert.ok(cleaned.includes('It’s always an honor for me to talk about Bisafans'), 'Expected interview responses to be preserved');
	});

	await test('HTML Parser (cleanContent): scifi_art.html strips Ghost Koenig cards, empty gallery cards, and styles while unwrapping image captions', async () => {
		const raw = fs.readFileSync(path.resolve(process.cwd(), 'scifi_art.html'), 'utf8');
		const cleaned = cleanContent(raw);

		assert.strictEqual(
			(cleaned.match(/\b(style|bgcolor|background)\s*=/gi) || []).length,
			0,
			'Expected no remaining inline style, bgcolor, or background attributes in cleaned scifi_art.html'
		);
		assert.strictEqual(
			(cleaned.match(/\bkg-[a-z0-9-]+\b/gi) || []).length,
			0,
			'Expected no remaining Ghost Koenig card classes in cleaned scifi_art.html'
		);
		assert.strictEqual(
			(cleaned.match(/<figure\b/gi) || []).length,
			0,
			'Expected no remaining figure tags (empty gallery cards removed, single captions unwrapped) in cleaned scifi_art.html'
		);

		// Verify key article content and captions are preserved
		assert.ok(cleaned.includes('December 1983 cover art'), 'Expected Computer Gaming World cover reference to be preserved');
		assert.ok(cleaned.includes('Via tech illustration curator'), 'Expected unwrapped image caption to be preserved');
		assert.ok(cleaned.includes('Lookcaitlin'), 'Expected caption link text to be preserved');
		assert.ok(cleaned.includes('Dalek'), 'Expected Doctor Who Dalek discussion to be preserved');
		assert.ok(cleaned.includes('What&#x2019;s Opera, Doc?'), 'Expected blockquote content to be preserved');
	});

	if (feedlyToken) {
		await test('Feedly API: /v3/tags returns valid boards list', async () => {
			try {
				const res = await requestUrl({
					url: 'https://cloud.feedly.com/v3/tags',
					method: 'GET',
					headers: {
						Authorization: `Bearer ${feedlyToken}`,
					},
				});
				assert.strictEqual(res.status, 200, 'Expected 200 OK from Feedly /v3/tags');
				assert.ok(Array.isArray(res.json), 'Expected array of Feedly tags/boards');
			} catch (e: any) {
				if (e.message?.includes('401') || e.message?.includes('token expired')) {
					console.log('- Skipping Feedly API test (FEEDLY_ACCESS_TOKEN expired)');
					return;
				}
				throw e;
			}
		});

		if (feedlyUserId) {
			await test('Feedly API: /v3/streams/contents returns valid stream items and cleanContent sanitizes their HTML', async () => {
				try {
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
				} catch (e: any) {
					if (e.message?.includes('401') || e.message?.includes('token expired')) {
						console.log('- Skipping Feedly stream test (FEEDLY_ACCESS_TOKEN expired)');
						return;
					}
					throw e;
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
