import axios from 'axios';
const origin = 'https://portal.recreation.ubc.ca';
export async function fetchPortal(url) {
  const target = new URL(url);
  if (target.origin !== origin || target.username || target.password || !target.pathname.startsWith('/intramurals/')) {
    throw new Error('Scraper URL outside allowed portal');
  }
  return axios.get(target.href, {
    timeout: 15000, maxContentLength: 5 * 1024 * 1024, maxBodyLength: 1024,
    maxRedirects: 0, proxy: false,
    headers: { 'User-Agent': 'UBC-IM-Notify/1.0' },
  });
}
