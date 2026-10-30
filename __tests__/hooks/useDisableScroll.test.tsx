import { renderHook } from '@testing-library/react';

import useDisableScroll from '@hooks/useDisableScroll';

const isLocked = () => document.body.classList.contains('no-scroll');

function renderLock(disable: boolean) {
  return renderHook(({ isDisabled }: { isDisabled: boolean }) => useDisableScroll(isDisabled), {
    initialProps: { isDisabled: disable },
  });
}

describe('useDisableScroll', () => {
  it('locks the page while a component asks, and unlocks it when that component stops asking or unmounts', () => {
    const lock = renderLock(true);
    expect(isLocked()).toBe(true);

    lock.rerender({ isDisabled: false });
    expect(isLocked()).toBe(false);

    lock.rerender({ isDisabled: true });
    expect(isLocked()).toBe(true);
    lock.unmount();
    expect(isLocked()).toBe(false);
  });

  it("keeps another component's lock when a component mounts without asking", () => {
    renderLock(true);
    renderLock(false);

    expect(isLocked()).toBe(true);
  });

  it('keeps the page locked until every component that asked stops asking', () => {
    const first = renderLock(true);
    const second = renderLock(true);

    first.rerender({ isDisabled: false });
    expect(isLocked()).toBe(true);
    first.unmount();
    expect(isLocked()).toBe(true);

    second.unmount();
    expect(isLocked()).toBe(false);
  });
});
