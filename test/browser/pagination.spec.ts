import { expect, test } from '@playwright/test'

const scroller = '[data-testid="scroller"]'

async function waitForBootstrap(page: import('@playwright/test').Page) {
  await expect(page.locator('[data-testid="window-end"]')).toHaveText('129')
  await page.waitForTimeout(400)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForBootstrap(page)
})

test('pins an asynchronous first load to the physical bottom', async ({ page }) => {
  const initialDistance = await page
    .locator(scroller)
    .evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))
  expect(initialDistance).toBeLessThanOrEqual(1)

  await page.locator('[data-testid="resize"]').click()
  await page.waitForTimeout(50)
  const distanceAfterReflow = await page
    .locator(scroller)
    .evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))
  expect(distanceAfterReflow).toBeLessThanOrEqual(1)
})

test('uses item edges through skeleton removal, preserves the anchor, and lands backward in the outer quarter', async ({
  page,
}) => {
  const result = await page.locator(scroller).evaluate(element => {
    const first = element.querySelector<HTMLElement>('[data-id]')!
    element.scrollTop = first.offsetTop + 100
    element.dispatchEvent(new Event('scroll'))
    const rows = [...element.querySelectorAll<HTMLElement>('[data-id]')]
    const viewportCenter = element.getBoundingClientRect().top + element.clientHeight / 2
    const anchor = rows.reduce((best, row) =>
      Math.abs(row.getBoundingClientRect().top - viewportCenter) <
      Math.abs(best.getBoundingClientRect().top - viewportCenter)
        ? row
        : best,
    )
    return { id: anchor.dataset.id!, top: anchor.getBoundingClientRect().top }
  })

  await expect(page.locator('[data-testid="fetches"]')).toHaveText('1')
  await expect(page.locator('[data-testid="skeleton"]')).toHaveCount(0)
  await page.waitForTimeout(400)

  const after = await page.locator(scroller).evaluate((element, anchor) => {
    const row = element.querySelector<HTMLElement>(`[data-id="${anchor.id}"]`)!
    const range = element.scrollHeight - element.clientHeight
    return { ratio: element.scrollTop / range, top: row.getBoundingClientRect().top }
  }, result)
  expect(Math.abs(after.top - result.top)).toBeLessThanOrEqual(1)
  expect(after.ratio).toBeGreaterThanOrEqual(0.75)
})

test('restores the same event and offset and compensates later row reflow', async ({ page }) => {
  await page.locator(scroller).evaluate(element => {
    element.scrollTop = 900
    element.dispatchEvent(new Event('scroll'))
  })
  await page.waitForTimeout(40)
  await page.locator('[data-testid="save"]').click()
  const savedId = await page.locator('[data-testid="saved-key"]').textContent()
  const before = {
    id: savedId!,
    top: await page.locator(`[data-id="${savedId}"]`).evaluate(element => element.getBoundingClientRect().top),
  }
  await page.locator('[data-testid="reset"]').click()
  await expect(page.locator('[data-testid="lifecycle-status"]')).toHaveText('idle')
  await page.locator('[data-testid="restore"]').click()
  await expect(page.locator('[data-testid="lifecycle-status"]')).toHaveText('idle')

  const restoredTop = await page
    .locator(`[data-id="${before.id}"]`)
    .evaluate(element => element.getBoundingClientRect().top)
  expect(Math.abs(restoredTop - before.top)).toBeLessThanOrEqual(1)

  await page.locator('[data-testid="resize"]').click()
  await page.waitForTimeout(50)
  const resizedTop = await page
    .locator(`[data-id="${before.id}"]`)
    .evaluate(element => element.getBoundingClientRect().top)
  expect(Math.abs(resizedTop - before.top)).toBeLessThanOrEqual(1)
})

test('lands forward in the opposite outer quarter with footer chrome present', async ({ page }) => {
  await page.locator(scroller).evaluate(element => {
    const first = element.querySelector<HTMLElement>('[data-id]')!
    element.scrollTop = first.offsetTop + 100
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(page.locator('[data-testid="fetches"]')).toHaveText('1')
  await page.waitForTimeout(400)

  await page.locator(scroller).evaluate(element => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await page.waitForTimeout(500)

  const ratio = await page.locator(scroller).evaluate(element => {
    const range = element.scrollHeight - element.clientHeight
    return element.scrollTop / range
  })
  expect(ratio).toBeLessThanOrEqual(0.25)
})

test('recovers when backward pages resolve without growing the source', async ({ page }) => {
  // Three fetches that add nothing, then normal pages. A page the consumer can't
  // place is not the start of the data, so the window must still advance.
  await page.goto('/?barren=3')
  await waitForBootstrap(page)

  const startBefore = await page.locator('[data-testid="window-start"]').textContent()

  for (let attempt = 0; attempt < 12; attempt++) {
    await page.locator(scroller).evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(300)
    const start = await page.locator('[data-testid="window-start"]').textContent()
    if (Number(start) < Number(startBefore)) break
  }

  const startAfter = await page.locator('[data-testid="window-start"]').textContent()
  expect(Number(startAfter)).toBeLessThan(Number(startBefore))

  // and the window must actually cover what was fetched, not strand it
  const [windowCount, sourceCount] = await Promise.all([
    page.locator('[data-testid="window-count"]').textContent(),
    page.locator('[data-testid="source-count"]').textContent(),
  ])
  expect(Number(sourceCount)).toBeGreaterThan(30)
  expect(Number(windowCount)).toBeGreaterThan(10)
})

test('extends the window into source items that arrived outside pagination', async ({ page }) => {
  const startBefore = Number(await page.locator('[data-testid="window-start"]').textContent())

  await page.locator('[data-testid="grow-external"]').click()
  await page.waitForTimeout(100)

  const sourceCount = Number(await page.locator('[data-testid="source-count"]').textContent())
  expect(sourceCount).toBeGreaterThanOrEqual(80)

  for (let attempt = 0; attempt < 12; attempt++) {
    await page.locator(scroller).evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(300)
    if (Number(await page.locator('[data-testid="window-start"]').textContent()) < startBefore) break
  }

  const startAfter = Number(await page.locator('[data-testid="window-start"]').textContent())
  const windowCount = Number(await page.locator('[data-testid="window-count"]').textContent())

  // the wedge in magi looked like source=80 / window=4: plenty loaded, none shown
  expect(startAfter).toBeLessThan(startBefore)
  expect(windowCount).toBeGreaterThan(10)
})

test('keeps filling when the window is shorter than the viewport', async ({ page }) => {
  // No scrollable range means no future scroll event, so a trigger that is armed
  // and ready can never be acted on. The fill has to re-drive itself.
  await page.goto('/?tall=1')
  await expect(page.locator('[data-testid="window-end"]')).toHaveText('129')
  await page.waitForTimeout(1500)

  const geometry = await page.locator(scroller).evaluate(element => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }))
  const windowCount = Number(await page.locator('[data-testid="window-count"]').textContent())

  // content must have grown past the viewport, not parked underneath it
  expect(geometry.scroll).toBeGreaterThan(geometry.client)
  expect(windowCount).toBeGreaterThan(30)
})
