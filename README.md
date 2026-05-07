# Obsidian Notion Sync

Sync Obsidian Markdown notes and attachments to Notion pages while preserving your vault folder structure.

## Features

- Sync the whole vault or the current note to Notion
- Preserve Obsidian folders as nested Notion pages
- Convert Markdown headings, paragraphs, lists, todos, quotes, dividers, and code blocks
- Upload local images, PDFs, audio, video, and generic files using Notion file uploads
- Convert Obsidian wikilinks such as `[[Page]]` to Notion page mentions when the target page exists
- Convert local Markdown links such as `[Page](folder/page.md)` to Notion page mentions
- Detect deleted/trashed Notion pages and recreate them
- Pre-create pages before content sync so `_INDEX.md` links can resolve correctly
- Optional auto-sync for changed Markdown notes

## Installation

### From Obsidian Community Plugins

This plugin is not yet listed. After approval, install it from Obsidian Settings → Community plugins.

### Manual install

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest GitHub release.
2. Create this folder in your vault:
   `.obsidian/plugins/obsidian-notion-sync/`
3. Copy the three files into that folder.
4. Reload Obsidian.
5. Enable **Obsidian Notion Sync** in Settings → Community plugins.

## Notion setup

You can connect in one of two ways.

### Option A: Internal integration token

1. Open <https://www.notion.so/profile/integrations>.
2. Create a new internal integration.
3. Copy the integration token.
4. Open the Notion parent page you want to sync into.
5. Use page menu → Connections → add your integration.
6. In plugin settings, paste the token into **Manual token fallback**.
7. Paste the parent page URL into **Notion parent page URL or ID**.
8. Click **Test connection**.

### Option B: OAuth

OAuth is supported for personal use. Because Obsidian plugins run locally, this implementation asks for your OAuth client ID and client secret in settings.

For public hosted OAuth, you should use a backend token-exchange proxy instead of storing the client secret in Obsidian.

1. Create a public Notion integration.
2. Add the same redirect URI that appears in plugin settings. Default:
   `https://localhost/obsidian-notion-sync`
3. Paste the OAuth client ID and client secret into plugin settings.
4. Click **Open Notion OAuth**.
5. Approve access in the browser.
6. Copy the full redirect URL from the browser address bar.
7. Paste it into **OAuth redirect URL or code**.
8. Click **Exchange**.
9. Paste the parent page URL into **Notion parent page URL or ID**.
10. Click **Test connection**.

## Commands

Open the Command Palette and run:

- `Sync current note to Notion`
- `Sync entire vault to Notion`
- `Force resync entire vault to Notion`
- `Test Notion connection`

## Settings

- **Notion integration token**: Manual token fallback. Stored in Obsidian plugin data.
- **OAuth client ID/client secret**: Used only if you choose OAuth.
- **Notion parent page URL or ID**: A Notion page URL or 32-character page ID. URLs are parsed automatically.
- **Auto sync changed notes**: Sync changed Markdown files after a short debounce.
- **Show skipped files in console**: Log unchanged files during full sync.

## Limitations

- Initial sync of large vaults can take a long time due to Notion API rate limits.
- Notion supports a limited set of block types compared with Markdown/Obsidian.
- Some Obsidian-specific syntax is rendered as plain text when no Notion equivalent exists.
- If you manually delete a block inside Notion while the local Markdown is unchanged, use **Force resync**.
- OAuth client secret storage is suitable for personal/local use, not ideal for a public shared OAuth app.

## Privacy and security

- This plugin sends note content and referenced attachments to the Notion API.
- Tokens are stored locally in Obsidian plugin data.
- Do not commit plugin data, tokens, or sync state to a public repository.
- Review your Notion integration permissions before syncing.

## Development

```bash
npm install
npm run build
```

Release assets required by Obsidian:

- `manifest.json`
- `main.js`
- `styles.css`

## License

MIT
