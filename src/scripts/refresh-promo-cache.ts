import fs from 'fs';
import {
  readPromoEnvelopeSync,
  refreshPromoBundle,
  resolvePromoBundlePath,
  resolvePromoCacheDir,
} from '../seo/promoCache';

function main(): void {
  const args = process.argv.slice(2);
  const dir = resolvePromoCacheDir();
  const bundlePath = resolvePromoBundlePath(dir);

  if (args.includes('--status')) {
    console.log(`[scanflow promo-cache] dir=${dir}`);
    const env = readPromoEnvelopeSync(dir);
    if (env && fs.existsSync(bundlePath)) {
      const size = fs.statSync(bundlePath).size;
      const articlesCount = Object.keys(env.data.articlesBySlug || {}).length;
      console.log(
        `  OK   promo-bundle           ${String(size).padStart(8)} B  articles=${articlesCount}  sig=${env.sourceSignature}  generatedAt=${env.generatedAt}`
      );
    } else {
      console.log('  MISS promo-bundle                  —  not generated');
    }
    return;
  }

  const t0 = Date.now();
  const env = refreshPromoBundle();
  const size = fs.statSync(bundlePath).size;
  const articlesCount = Object.keys(env.data.articlesBySlug || {}).length;
  console.log(
    `[scanflow promo-cache] refreshed ${bundlePath} (${size} B, ${articlesCount} articles, ${Date.now() - t0} ms)`
  );
}

main();
