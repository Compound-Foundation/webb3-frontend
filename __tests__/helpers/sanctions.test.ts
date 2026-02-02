import { isSanctioned } from '@helpers/sanctions';

describe('isSanctioned', () => {
  it('sanctioned address regardless of case', () => {
    expect(isSanctioned('0x8589427373D6D84E98730D7795D8f6f8731FDA16')).toBeTruthy();
    expect(isSanctioned('0x8589427373d6d84e98730d7795d8f6f8731fda16')).toBeTruthy();
    expect(isSanctioned('0X8589427373D6D84E98730D7795D8F6F8731FDA16')).toBeTruthy();
  });

  it('unsanctioned address regardless of case', () => {
    expect(isSanctioned('0x0000000000000000000000000000000000000aa1')).toBeFalsy();
    expect(isSanctioned('0x0000000000000000000000000000000000000aA1')).toBeFalsy();
    expect(isSanctioned('0x0000000000000000000000000000000000000AA1')).toBeFalsy();
  });
});
