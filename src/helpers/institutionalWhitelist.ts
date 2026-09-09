// Manually maintained allowlist of addresses eligible for the institutional
// market's boosted supply rate. To whitelist an address, add it to the array
// below (checksummed or not — comparison is case-insensitive).
const WHITELISTED_ADDRESSES: string[] = [
  '0xB819706e897eaCf235CdB5048962bD65873202C4', // test account
  '0x3e323C347D4bdd129741fE202b4038EE460BEb50', // test account
  '0x38F6a1B46144fAEe6a6D9F79D8dE264C18e23848',
  '0x0efccbb9e2c09ea29551879bd9da32362b32fc89',
  '0x616de58c011f8736fa20c7ae5352f7f6fb9f0669',
  '0x4352Cc849b33a936Ad93bB109aFDec1c89653b4f',
  '0x8BacCcA3e83843555867b3865d7689D099406567',
  '0xdCD8Cb1E2Ba62fAEF6c4C258508D7D959E5F3408',
  '0x1676D23711186076Fa74aa53511dDa750A1F0D9A',
  '0x5f2b6e70aa6a217e9ecd1ed7d0f8f38ce9a348a2',
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
