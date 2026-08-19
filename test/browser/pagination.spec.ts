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
