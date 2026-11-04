// Flow "scraper": fetch a JSON API, pick fields, filter, write CSV.
import { fetchUrl, pick, filter, writeCsv, log } from './lib';

const url = 'http://127.0.0.1:0/api/posts';
const data = await fetchUrl({ url, as: 'json', method: 'GET' });
const posts = await pick({ from: data, field: 'items' });
const bun = await filter({ items: posts, field: 'title', op: 'contains', value: 'bun' });
const csv = await writeCsv({ path: 'out/posts.csv', rows: bun, columns: 'id, title, url' });
await log({ value: csv });
