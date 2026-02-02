import { Contract } from '@ethersproject/contracts';

import { TokenWithAccountState } from '@types';

export function filterMap<T, U>(array: T[], callbackFn: (value: T) => U | undefined): U[] {
  return array.reduce<U[]>((acc, value) => {
    const maybeU = callbackFn(value);
    if (maybeU === undefined) {
      return acc;
    } else {
      return [...acc, maybeU];
    }
  }, []);
}

export async function tryOrDecodeError(contract: Contract, method: string, args: string[]) {
  // Note: This is a hack bc ethers seems to be broken in at least estimateGas,
  //  where it fails to parse or include the error selector from a revert.
  // So we here just try the tx, and if it fails we try to extract the error from a staticCall.
  // Hopefully we can get rid of this altogether with a future version of ethers.
  try {
    const trx = await contract[method](...args);
    console.log(trx);
  } catch (e) {
    console.error(e);
    try {
      await contract.callStatic[method](...args);
    } catch (e_) {
      if (e_ instanceof Error) {
        const match = e_.message.match(/Reverted (0x[a-fA-F0-9]*)/);
        if (match) {
          console.error('Decoded error', contract.interface.parseError(match[1]));
        }
      } else {
        console.error('Unknown decode error: ', e_);
      }
    }
  }
}

export function arrayPartition(array: TokenWithAccountState[], testFunction: (arg0: TokenWithAccountState) => boolean) {
  const matches: TokenWithAccountState[] = [];
  const nonMatches: TokenWithAccountState[] = [];

  array.forEach((element) => (testFunction(element) ? matches : nonMatches).push(element));
  return [matches, nonMatches];
}

export function checkImageURL(url: string) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => {
      resolve(true); // URL loaded successfully as an image
    });
    img.addEventListener('error', () => {
      reject(false); // URL is not an image or failed to load
    });
    img.src = url;
  });
}

// returns title, description from decoded proposal body
export function parseTitleDescriptionFromBody(description: string): {
  title: string;
  description: string;
} {
  const match = description.match(/\s*#\s+([^\r\n]+)/);
  if (match === null || match.index === undefined) {
    return { title: 'Untitled', description };
  }
  description = description.slice(match.index + match[0].length);
  return {
    title: match[1],
    description: description.trim(),
  };
}

type TimeElement = {
  singleName: string;
  pluralName: string;
  len: number;
};

const timeElements: TimeElement[] = [
  {
    singleName: 'year',
    pluralName: 'years',
    len: 60 * 60 * 24 * 365,
  },
  {
    singleName: 'day',
    pluralName: 'days',
    len: 60 * 60 * 24,
  },
  {
    singleName: 'hr',
    pluralName: 'hrs',
    len: 60 * 60,
  },
  {
    singleName: 'min',
    pluralName: 'mins',
    len: 60,
  },
  {
    singleName: 'second',
    pluralName: 'seconds',
    len: 1,
  },
];

// takes time in seconds
// returns readable str time in days, hrs, mins
// returns only 2 units of time (ie. if largest time unit is days, returns days + hrs)
export function timeInWords(time: number) {
  const [str]: [string[], number] = timeElements.reduce(
    ([acc, remaining]: [string[], number], { singleName, pluralName, len }) => {
      if (remaining >= len && acc.length < 2) {
        const amt = Math.floor(remaining / len);
        const name = amt === 1 ? singleName : pluralName;
        const el = `${amt} ${name}`;
        return [[...acc, el], remaining - amt * len];
      } else {
        return [acc, remaining];
      }
    },
    [[], Math.abs(time)]
  );

  const finalStr = str.length === 0 ? `0 ${timeElements[timeElements.length - 1].pluralName}` : str.join(', ');

  return finalStr;
}

export function formatDateWithSuffix(date: Date) {
  const month = date.toLocaleString('default', { month: 'long' });
  const day = date.getDate();
  let suffix = 'th';
  if (day === 1 || day === 21 || day === 31) {
    suffix = 'st';
  } else if (day === 2 || day === 22) {
    suffix = 'nd';
  } else if (day === 3 || day === 23) {
    suffix = 'rd';
  }
  const year = date.getFullYear();
  return `${month} ${day}${suffix}, ${year}`;
}

export function convertSnakeToCamel(str: string) {
  return str.replace(/(_\w)/g, (m) => m[1].toUpperCase());
}

function isObject(item: { [x: string]: unknown }): boolean {
  return typeof item === 'object' && !Array.isArray(item) && item !== null;
}

function transformObject(obj: { [x: string]: unknown }) {
  const res: Record<string, unknown> = {};
  Object.keys(obj).forEach((key) => {
    const newKey = convertSnakeToCamel(key);
    res[newKey] = obj[key];
  });
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertApiResponse<T extends Record<string, any>>(response: T): Record<string, any> {
  return Object.keys(response).reduce((acc, key) => {
    const newKey = convertSnakeToCamel(key);
    return {
      ...acc,
      [newKey]: Array.isArray(response[key])
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          response[key].map((data: any) => {
            if (typeof data === 'string') return data;
            return convertApiResponse(data);
          })
        : isObject(response[key])
        ? transformObject(response[key])
        : response[key],
    };
  }, {});
}

export function isValidAddress(address: string): boolean {
  // Check if the address is a valid length and contains only hex characters
  if (!/^(0x)?[0-9a-fA-F]{40}$/i.test(address)) return false;
  else if (Number(address) === 0) return false; // consider zero address invalid
  else if (/^(0x)?[0-9a-fA-F]{40}$/.test(address) || /^(0x)?[0-9A-Fa-f]{40}$/.test(address)) return true;
  else return false;
}

export function noop(): void {
  // silence linter error
}
