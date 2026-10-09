export default async function verifyAuthScreen(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const mobile = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    authVisible: !document.querySelector('#auth-screen').hidden,
    formWidth: Math.round(document.querySelector('.auth-form-panel').getBoundingClientRect().width),
  }));
  if (mobile.documentWidth > mobile.viewportWidth) throw new Error('Mobile auth screen overflows horizontally.');
  await page.getByRole('button', { name: 'Create account' }).click();
  const registrationVisible = await page.locator('#register-form').isVisible();
  if (!registrationVisible) throw new Error('Create account form did not open.');
  return { mobile, registrationVisible };
}