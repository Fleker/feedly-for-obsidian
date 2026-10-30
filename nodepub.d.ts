declare module 'nodepub' {
  export interface DocumentOptions {
    id: string;
    title: string;
    author: string;
    publisher?: string;
    cover?: string;
    description?: string;
    tags?: string[];
  }

  export interface NodepubFile {
    name: string;
    folder: string;
    content: string | Uint8Array;
    data?: string | Uint8Array;
  }

  export interface Document {
    addCSS(css: string): void;
    addSection(title: string, content: string, excludeFromToc?: boolean, isFrontMatter?: boolean): void;
    getFilesForEPUB(): Promise<NodepubFile[]>;
  }

  export function document(options: DocumentOptions): Document;
}
