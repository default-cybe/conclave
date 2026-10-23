/**
 * The engines WebSearch can use (Settings > Web search): each one's free
 * allowance and how to get a key. Data and types only, so the apps can
 * import it; the hub side is search-settings.ts. Allowances are from each
 * provider's own pages, checked 2026-10-23. The order is the automatic
 * order (websearch.ts pickProvider): the biggest free allowance with no card
 * first, DuckDuckGo last.
 */
import type { ConclaveConfig } from '../config/schema';

/** The same ids as websearch.ts, from the schema so the apps never load the tool. */
export type SearchProviderId = Exclude<ConclaveConfig['search']['provider'], 'auto'>;

export interface SearchProviderStep {
  text: string;
  url?: string;
}

export interface SearchProviderInfo {
  id: SearchProviderId;
  name: string;
  /** The free allowance, in words. */
  free: string;
  /** A card is needed to sign up, even for the free allowance. null: the provider's pages do not say. */
  card: boolean | null;
  /** What the hub needs: a key, a server address, or nothing. */
  needs: 'key' | 'url' | 'none';
  steps: SearchProviderStep[];
  keyHint?: string;
  docsUrl?: string;
  /** Environment variables the hub also reads the key or address from. */
  env?: string[];
}

export const SEARCH_PROVIDERS: SearchProviderInfo[] = [
  {
    id: 'tavily',
    name: 'Tavily',
    free: '1,000 API credits a month, about 1,000 searches. No card.',
    card: false,
    needs: 'key',
    steps: [
      { text: 'Sign up for free. No card is needed.', url: 'https://app.tavily.com' },
      { text: 'Copy the API key from the dashboard. It starts with tvly-.', url: 'https://app.tavily.com' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    keyHint: 'Starts with tvly-',
    docsUrl: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
    env: ['TAVILY_API_KEY'],
  },
  {
    id: 'exa',
    name: 'Exa',
    free: '$10 of credit at sign-up, reset to $10 on the 1st of each month for your first team. No card.',
    card: false,
    needs: 'key',
    steps: [
      { text: 'Sign up. No payment method is needed.', url: 'https://dashboard.exa.ai' },
      { text: 'Optional: finish the onboarding in the dashboard for a one-time $10 bonus.' },
      { text: 'Open API keys and create a key.', url: 'https://dashboard.exa.ai/api-keys' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://exa.ai/docs/reference/search',
    env: ['EXA_API_KEY'],
  },
  {
    id: 'langsearch',
    name: 'LangSearch',
    free: 'Free plan, $0 a month, with a daily token allowance. The numbers are not stated; the dashboard shows usage. New accounts start at 5 requests a second. Card: not stated.',
    card: null,
    needs: 'key',
    steps: [
      { text: 'Sign in or create an account in the dashboard.', url: 'https://langsearch.com/dashboard' },
      { text: 'Choose API keys and create a key. Copy it while the full key is shown.' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://docs.langsearch.com/reference/search-api-guide.md',
    env: ['LANGSEARCH_API_KEY'],
  },
  {
    id: 'linkup',
    name: 'Linkup',
    free: '$20 of credit at sign-up, topped back up to $20 each month for eligible accounts: 4,000 queries. The docs tie the credit to signing up with a professional email. Card: not stated.',
    card: null,
    needs: 'key',
    steps: [
      { text: 'Create a free account. Use a professional email if you have one: the $20 credit is documented only for those.', url: 'https://app.linkup.so' },
      { text: 'Copy the API key from the dashboard.' },
      { text: 'Check your balance under Billing.', url: 'https://app.linkup.so/organization/billing' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://docs.linkup.so/pages/documentation/get-started/quickstart',
    env: ['LINKUP_API_KEY'],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    free: '1,000 credits a month, about 500 searches (2 credits per 10 results). 10 searches a minute. No card.',
    card: false,
    needs: 'key',
    steps: [
      { text: 'Create a free account. No card is needed.', url: 'https://www.firecrawl.dev/app/api-keys' },
      { text: 'Copy the API key on the API keys page. It starts with fc-.' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    keyHint: 'Starts with fc-',
    docsUrl: 'https://docs.firecrawl.dev/features/search',
    env: ['FIRECRAWL_API_KEY'],
  },
  {
    id: 'youcom',
    name: 'You.com',
    free: '$10 of free credit, about 2,000 searches. Credit expiry: not stated. Card: not stated.',
    card: null,
    needs: 'key',
    steps: [
      { text: 'Sign in or create an account.', url: 'https://you.com/platform' },
      { text: 'Open API keys, click Create API Key and name it.', url: 'https://you.com/platform/api-keys' },
      { text: 'Copy the key right away. It is shown only once.' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://you.com/docs/api-reference/search/v1-search',
    env: ['YDC_API_KEY'],
  },
  {
    id: 'serper',
    name: 'Serper',
    free: '2,500 free queries. Whether they renew each month is not stated. No card.',
    card: false,
    needs: 'key',
    steps: [
      { text: 'Create an account with your name, email and a password. No card is needed.', url: 'https://serper.dev/signup' },
      { text: 'Log in and copy the API key from the dashboard.', url: 'https://serper.dev/login' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://serper.dev/',
    env: ['SERPER_API_KEY'],
  },
  {
    id: 'serpapi',
    name: 'SerpApi',
    free: '250 searches a month, 50 an hour. Only successful searches count. Card: not stated.',
    card: null,
    needs: 'key',
    steps: [
      { text: 'Sign up with GitHub or Google.', url: 'https://serpapi.com/users/sign_up' },
      { text: 'Stay on the Free plan.', url: 'https://serpapi.com/pricing' },
      { text: 'Open Manage API key and copy the key.', url: 'https://serpapi.com/manage-api-key' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://serpapi.com/search-api',
  },
  {
    id: 'jina',
    name: 'Jina Search',
    free: 'A one-time 10M free tokens per new key, for non-commercial use. A search costs at least 10,000 tokens, so roughly 1,000 searches. No card.',
    card: false,
    needs: 'key',
    steps: [
      { text: 'Open Jina Reader and click Get your API key. Every new key comes with 10M free tokens.', url: 'https://jina.ai/reader/' },
      { text: 'Copy the key.' },
      { text: 'Check the balance later under API key and billing.', url: 'https://jina.ai/api-dashboard/' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://jina.ai/reader/',
    env: ['JINA_API_KEY'],
  },
  {
    id: 'brave',
    name: 'Brave Search',
    free: '$5 of free credit each month, about 1,000 searches. Unused free credit does not roll over.',
    card: true,
    needs: 'key',
    steps: [
      { text: 'Create an account with your email and a password, then verify the email.', url: 'https://api-dashboard.search.brave.com/register' },
      { text: 'Open Plans and subscribe to the Search plan.', url: 'https://api-dashboard.search.brave.com/app/subscriptions/subscribe' },
      { text: 'Enter a card. To use only the free monthly credit, choose prepaid and set the prepay amount to $0. A $0 or $1 hold is refunded right away.' },
      { text: 'Open API keys, click Add API key, name it and copy it.', url: 'https://api-dashboard.search.brave.com/app/keys' },
      { text: 'Paste it here, press Save, then Test.' },
    ],
    docsUrl: 'https://api-dashboard.search.brave.com/documentation/quickstart',
    env: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    free: 'Your own server. No account and no key.',
    card: false,
    needs: 'url',
    steps: [
      { text: 'Run a SearXNG server the hub can reach.', url: 'https://docs.searxng.org/' },
      { text: 'In its settings.yml, add json to search.formats so the hub can read results.' },
      { text: 'Paste its address here, press Save, then Test.' },
    ],
    docsUrl: 'https://docs.searxng.org/',
    env: ['SEARXNG_URL'],
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    free: 'No account and no key. Used when nothing else is set up. It often answers a hub with a bot check, so searches can fail.',
    card: false,
    needs: 'none',
    steps: [],
  },
];

export type SearchChoice = ConclaveConfig['search']['provider'];

export interface WebSearchSettingsDto {
  /** What the owner chose: auto picks the first engine with a key. */
  chosen: SearchChoice;
  /** The engine WebSearch uses now. */
  active: SearchProviderId;
  /** The SearXNG address, and where it comes from. */
  url?: string;
  urlFrom?: 'config' | 'env';
  providers: Array<SearchProviderInfo & { keySet: boolean; keyFrom?: 'hub' | 'config' | 'env' }>;
}

export interface WebSearchSettingsPatch {
  provider?: SearchChoice;
  url?: string | null;
}

export interface WebSearchTestResult {
  provider: SearchProviderId;
  ok: boolean;
  message: string;
}
