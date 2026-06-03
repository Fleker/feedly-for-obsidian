import { Notice, requestUrl, RequestUrlParam } from 'obsidian';
const OAuth = require('oauth-1.0a');
const hmacSHA1 = require('crypto-js/hmac-sha1');
const Base64 = require('crypto-js/enc-base64');

type OAuth = any;

namespace OAuth {
    export interface Token {
        key: string;
        secret: string;
    }
    export type RequestOptions = any;
}

export class InstapaperClient {
    private oauth: OAuth;
    private token?: OAuth.Token;

    constructor(consumerKey: string, consumerSecret: string, tokenKey?: string, tokenSecret?: string) {
        // Initialize the OAuth 1.0a signer
        this.oauth = new OAuth({
            consumer: { key: consumerKey, secret: consumerSecret },
            signature_method: 'HMAC-SHA1',
            hash_function(base_string: string, key: string) {
                // Instapaper requires HMAC-SHA1 signatures
                return hmacSHA1(base_string, key).toString(Base64);
            },
        });

        // If you already have the user's token saved in your plugin settings, load it here
        if (tokenKey && tokenSecret) {
            this.token = { key: tokenKey, secret: tokenSecret };
        }
    }

    /**
     * Step 1: Authenticate using xAuth
     * Trades username/password for a permanent OAuth token
     */
    async authenticate(username: string, password: string): Promise<OAuth.Token> {
        const requestData = {
            url: 'https://www.instapaper.com/api/1/oauth/access_token',
            method: 'POST',
            data: {
                x_auth_username: username,
                x_auth_password: password,
                x_auth_mode: 'client_auth'
            }
        };

        const responseText = await this.executeRequest(requestData, false);
        
        // The xAuth endpoint returns form-urlencoded data, e.g., oauth_token=...&oauth_token_secret=...
        const params = new URLSearchParams(responseText);
        this.token = {
            key: params.get('oauth_token') || '',
            secret: params.get('oauth_token_secret') || ''
        };

        return this.token;
    }

    /**
     * Fetch the user's unread bookmarks
     */
    async getBookmarks(limit: number = 25) {
        const requestData = {
            url: 'https://www.instapaper.com/api/1/bookmarks/list',
            method: 'POST',
            data: { limit }
        };

        const responseText = await this.executeRequest(requestData);
        return JSON.parse(responseText);
    }

    /**
     * Add a new bookmark
     */
    async addBookmark(url: string, title?: string, description?: string) {
        const requestData = {
            url: 'https://www.instapaper.com/api/1/bookmarks/add',
            method: 'POST',
            data: { url, title, description }
        };

        const responseText = await this.executeRequest(requestData);
        return JSON.parse(responseText);
    }

    /**
     * Archive a bookmark
     */
    async archiveBookmark(bookmarkId: number) {
        const requestData = {
            url: 'https://www.instapaper.com/api/1/bookmarks/archive',
            method: 'POST',
            data: { bookmark_id: bookmarkId }
        };

        const responseText = await this.executeRequest(requestData);
        return JSON.parse(responseText);
    }

    /**
     * Retrieves the parsed HTML content of a bookmark
     * @param bookmarkId The ID of the bookmark to fetch
     * @returns A string containing the HTML of the article
     */
    async getText(bookmarkId: number | string): Promise<string | null> {
        const requestData = {
            url: 'https://www.instapaper.com/api/1.1/bookmarks/get_text',
            method: 'POST',
            data: { bookmark_id: String(bookmarkId) }
        };

        // This endpoint returns raw HTML, so we do not use JSON.parse() here
        try {
            const response = await this.executeRequest(requestData);
            return response;
        } catch (e) {
            new Notice(`Cannot fetch article ${bookmarkId}`)
        }
        return null
    }

    /**
     * Core Request Engine using Obsidian's native requestUrl
     */
    private async executeRequest(requestData: OAuth.RequestOptions, useToken: boolean = true): Promise<string> {
        // Generate the OAuth 1.0a authorization header
        const authorization = this.oauth.authorize(requestData, useToken ? this.token : undefined);
        const headers = this.oauth.toHeader(authorization) as Record<string, string>;

        // Convert the JSON data payload into x-www-form-urlencoded format
        const bodyParams = new URLSearchParams();
        if (requestData.data) {
            for (const [key, value] of Object.entries(requestData.data)) {
                if (value !== undefined && value !== null) {
                    bodyParams.append(key, String(value));
                }
            }
        }

        const options: RequestUrlParam = {
            url: requestData.url,
            method: requestData.method,
            headers: {
                ...headers,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: bodyParams.toString()
        };

        try {
            // Using Obsidian's requestUrl bypasses browser CORS limitations
            const response = await requestUrl(options);
            return response.text; 
        } catch (error) {
            console.error("Instapaper API Request Failed:", error);
            throw error;
        }
    }
}