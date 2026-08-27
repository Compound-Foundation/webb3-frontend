// Manually maintained allowlist of addresses eligible for the institutional
// market's boosted supply rate. To whitelist an address, add it to the array
// below (checksummed or not — comparison is case-insensitive).
const WHITELISTED_ADDRESSES: string[] = [
  '0xB819706e897eaCf235CdB5048962bD65873202C4', // test account
  '0x3e323C347D4bdd129741fE202b4038EE460BEb50', // test account
];

export enum InstitutionalWhitelistStatus {
  NoWallet = 'no-wallet',
  NotWhitelisted = 'not-whitelisted',
  Whitelisted = 'whitelisted',
}

export function institutionalWhitelistStatus(account: string | undefined): InstitutionalWhitelistStatus {
  if (account === undefined || account === '') {
    return InstitutionalWhitelistStatus.NoWallet;
  }
  return WHITELISTED_ADDRESSES.some((address) => address.toLowerCase() === account.toLowerCase())
    ? InstitutionalWhitelistStatus.Whitelisted
    : InstitutionalWhitelistStatus.NotWhitelisted;
}
