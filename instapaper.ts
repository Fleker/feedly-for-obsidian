import { Notice, requestUrl, RequestUrlParam } from 'obsidian';

export type InstapaperBookmarkSection = 'home' | 'archive' | 'liked' | 'folder' | 'tag';

export interface InstapaperTag {
    id: number;
    name: string;
    slug: string;
    count: number;
}

export interface InstapaperProgress {
    percentage: number;
    timestamp: number;
}

export interface InstapaperBookmark {
    id: number;
    url: string | null;
    title: string | null;
    description: string | null;
    image: string | null;
    progress: InstapaperProgress;
    liked: boolean;
    archived: boolean;
    time: number;
    pubtime: number | null;
    author: string | null;
    folder_id: number | null;
    tags: InstapaperTag[];
    private_source: string | null;
    category: number;
}

export interface InstapaperBookmarkList {
    bookmarks: InstapaperBookmark[];
    total: number;
    deleted_ids?: number[];
}

export interface InstapaperFolder {
    id: number;
    title: string;
    slug: string;
    position: number;
    public: boolean;
    count: number;
}

export interface InstapaperParsedResult {
    metadata: {
        title: string | null;
        author: { name: string; url: string | null } | null;
        pubtime: number | null;
        thumbnail: string | null;
        description: string | null;
        private_source: string | null;
        category: number;
    };
    content: {
        body: string | null;
        images: string[];
        words: number | null;
        paywalled: boolean;
        direction: string | null;
    };
}

export class InstapaperClient {
    private accessToken: string;
    private baseUrl = 'https://www.instapaper.com/api/2';

    constructor(accessToken: string) {
        this.accessToken = accessToken;
    }

    /**
     * Fetch a page of bookmarks for a given section or folder
     */
    async getBookmarks(
        limit: number = 25,
        folderId?: number,
        offset: number = 0,
        section?: InstapaperBookmarkSection
    ): Promise<InstapaperBookmarkList> {
        return this.executeRequest<InstapaperBookmarkList>('GET', '/bookmarks', {
            query: {
                section,
                folder_id: folderId,
                limit,
                offset,
            }
        });
    }

    /**
     * Fetch user's custom folders
     */
    async getFolders(): Promise<InstapaperFolder[]> {
        const res = await this.executeRequest<{ folders: InstapaperFolder[] }>('GET', '/folders');
        return res.folders ?? [];
    }

    /**
     * Add a new bookmark
     */
    async addBookmark(url: string, title?: string, description?: string, folderId?: number): Promise<InstapaperBookmark> {
        const body: Record<string, unknown> = { url };
        if (title !== undefined) body.title = title;
        if (description !== undefined) body.description = description;
        if (folderId !== undefined) body.folder_id = folderId;

        return this.executeRequest<InstapaperBookmark>('POST', '/bookmarks', {
            json: body
        });
    }

    /**
     * Archive a bookmark
     */
    async archiveBookmark(bookmarkId: number): Promise<InstapaperBookmark> {
        return this.executeRequest<InstapaperBookmark>('POST', `/bookmarks/${bookmarkId}/move`, {
            json: { section: 'archive' }
        });
    }

    /**
     * Retrieves the parsed metadata and HTML content of a bookmark
     * @param bookmarkId The ID of the bookmark to fetch
     * @returns The parsed result containing metadata and HTML content
     */
    async parseBookmark(bookmarkId: number | string): Promise<InstapaperParsedResult | null> {
        try {
            return await this.executeRequest<InstapaperParsedResult>('GET', `/bookmarks/${bookmarkId}/parse`);
        } catch (e) {
            console.error(`Cannot fetch article ${bookmarkId}`, e);
            new Notice(`Cannot fetch article ${bookmarkId}`);
        }
        return null;
    }

    /**
     * Retrieves the parsed HTML content of a bookmark
     * @param bookmarkId The ID of the bookmark to fetch
     * @returns A string containing the HTML of the article
     */
    async getText(bookmarkId: number | string): Promise<string | null> {
        const response = await this.parseBookmark(bookmarkId);
        return response?.content?.body ?? null;
    }

    /**
     * Core Request Engine using Obsidian's native requestUrl
     */
    private async executeRequest<T>(
        method: string,
        path: string,
        options?: {
            query?: Record<string, string | number | boolean | undefined>;
            json?: Record<string, unknown>;
        }
    ): Promise<T> {
        let url = `${this.baseUrl}${path}`;
        if (options?.query) {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(options.query)) {
                if (value !== undefined && value !== null) {
                    params.append(key, String(value));
                }
            }
            const qs = params.toString();
            if (qs) {
                url += `?${qs}`;
            }
        }

        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json',
        };

        let body: string | undefined;
        if (options?.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(options.json);
        }

        const reqOptions: RequestUrlParam = {
            url,
            method,
            headers,
            body,
        };

        try {
            // Using Obsidian's requestUrl bypasses browser CORS limitations
            const response = await requestUrl(reqOptions);
            return response.json as T;
        } catch (error) {
            console.error('Instapaper API Request Failed:', error);
            throw error;
        }
    }
}