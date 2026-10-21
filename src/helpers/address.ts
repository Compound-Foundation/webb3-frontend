// COM-293 end-to-end test of pr-agents; this PR is closed without merging.
export const getShortAddress = (address: string): string => `0x${address.slice(2, 6)}...${address.slice(-4)}`;
