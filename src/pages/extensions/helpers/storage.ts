/**
 * Extensions - Storage
 *
 * Here we define functions to store two types of data related to
 * extensions. First, we store the extensions enabled for a given
 * account (as a simple list). Then, secondly, we give each extension
 * a key-value storage interface to store local settings. This could
 * used to say, store the user's email address for notifications, or
 * the user's light-dark preference.
 *
 * Note: the interfaces here are async since there is an expectation
 *       this data may one day be synced and retrieved from a remote
 *       source.
 */

export async function getExtensions(account: string): Promise<string[]> {
  return (await getKV<string[]>(account, 'extensions')) ?? [];
}

export async function putExtensions(account: string, extensions: string[]) {
  await putKV<string[]>(account, 'extensions', extensions);
}

function getKey(account: string, key: string): string {
  return `webb3:${account}:${key}`;
}

function extensionSubKey(id: string, key: string): string {
  return `extensions:${id}:${key}`;
}

export async function getExtensionKV(account: string, id: string, key: string): Promise<string | null> {
  return await getKV(account, extensionSubKey(id, key));
}

export async function putExtensionKV(account: string, id: string, key: string, value: string) {
  return await putKV(account, extensionSubKey(id, key), value);
}

async function getKV<T>(account: string, key: string): Promise<T | null> {
  if ('localStorage' in window) {
    const x = window.localStorage.getItem(getKey(account, key));
    if (typeof x === 'string') {
      return JSON.parse(x) as T;
    } else {
      return null;
    }
  } else {
    return null;
  }
}

async function putKV<T>(account: string, key: string, value: T) {
  if ('localStorage' in window) {
    window.localStorage.setItem(getKey(account, key), JSON.stringify(value));
  }
}
