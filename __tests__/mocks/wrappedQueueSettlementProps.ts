// Home's children record their props: those of the first tab in `mockLastProps`, and every tab's in
// `mockTabProps`. Each wrappedQueueSettlement test file mocks the children with `mockRecordProps`
// through `jest.requireActual`. That call shares the test file's module registry, so the fixture and
// the tests read the same records.
export const mockLastProps: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
export const mockTabProps: Record<string, Record<string, any>> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
export const mockTab = jest.requireActual('react').createContext('a');
export function mockRecordProps(name: string) {
  return {
    __esModule: true,
    default: (props: unknown) => {
      const tab: string = jest.requireActual('react').useContext(mockTab);
      if (tab === 'a') mockLastProps[name] = props;
      mockTabProps[tab] = { ...mockTabProps[tab], [name]: props };
      return null;
    },
  };
}
