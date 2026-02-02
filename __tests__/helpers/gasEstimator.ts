import { applyGasMaskAndSuffix } from '@helpers/gasEstimator';

describe('applyGasMaskAndSuffix', () => {
  it('should correctly apply gas mask and suffix', () => {
    const gasEstimate = 123456;
    const result = applyGasMaskAndSuffix(gasEstimate);
    expect(result).toEqual(121234);
  });
});
