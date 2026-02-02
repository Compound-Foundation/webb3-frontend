export const getShortAddress = (address: string): string => `0x${address.slice(2, 6)}...${address.slice(-4)}`;
