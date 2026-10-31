/** Shared storage shape for imported X bookmarks. */
export interface XBookmark {
  id: string;
  url: string;
  title: string;
  folder: string;
  extendedContent: string;
  contentType: string;
  indexStatus: 'indexed';
  indexedAt: number;
  author: string;
  imageUrl?: string;
  cloudHash?: string;
  cloudProject?: string;
}
