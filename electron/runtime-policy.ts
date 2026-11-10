const productionUrl = 'receiptmatch://app/index.html';
const developmentUrl = 'http://127.0.0.1:4310/';
type RendererUrl = typeof productionUrl | typeof developmentUrl;

export function resolveRendererUrl(isPackaged: boolean, startUrl?: string): RendererUrl {
    if (isPackaged || startUrl === undefined) return productionUrl;
    if (startUrl !== developmentUrl) throw new Error(`ELECTRON_START_URL must be exactly ${developmentUrl}`);
    return developmentUrl;
}

export function isRendererRequestAllowed(rendererUrl: RendererUrl, requestUrl: string): boolean {
    const development = rendererUrl === developmentUrl;
    const prefixes = development ? [developmentUrl, 'ws://127.0.0.1:4310/'] : rendererUrl === productionUrl ? ['receiptmatch://app/'] : [];
    if (!prefixes.some(prefix => requestUrl.startsWith(prefix))) return false;
    try {
        const url = new URL(requestUrl);
        // Reject aliases/normalization tricks instead of letting URL parsing broaden the fixed authorities.
        return url.href === requestUrl && !url.username && !url.password && !requestUrl.includes('#') && (development || !requestUrl.includes('?'));
    } catch { return false; }
}
