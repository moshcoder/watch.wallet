import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/server.ts'

// robots.txt and sitemap.xml touch no store: a bare app answers them.
const app = createApp({ key: 'k'.repeat(40) } as unknown as Parameters<typeof createApp>[0])

describe('crawler files', () => {
  test('through the pit.world relay they name watch.wallet.pit.world', async () => {
    const headers = { host: 'watch.wallet', 'x-forwarded-proto': 'https', 'x-moshpit-name': 'watch.wallet' }
    const robots = await app.request('/robots.txt', { headers })
    expect(robots.status).toBe(200)
    expect(robots.headers.get('content-type')).toContain('text/plain')
    expect(await robots.text()).toContain('Sitemap: https://watch.wallet.pit.world/sitemap.xml')
    const map = await app.request('/sitemap.xml', { headers })
    expect(map.status).toBe(200)
    expect(map.headers.get('content-type')).toContain('application/xml')
    const xml = await map.text()
    expect(xml).toContain('<loc>https://watch.wallet.pit.world/</loc>')
    expect(xml).not.toMatch(/<loc>(?!https:\/\/watch\.wallet\.pit\.world\/)/)
  })

  test('on Moshpit itself they name watch.wallet', async () => {
    const headers = { host: 'watch.wallet', 'x-forwarded-proto': 'https' }
    expect(await (await app.request('/robots.txt', { headers })).text()).toContain('Sitemap: https://watch.wallet/sitemap.xml')
    const xml = await (await app.request('/sitemap.xml', { headers })).text()
    expect(xml).toContain('<loc>https://watch.wallet/</loc>')
    expect(xml).not.toContain('.pit.world')
  })
})
