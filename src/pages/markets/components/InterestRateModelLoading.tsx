import { formatPoints, getHorizontalLineMarkers, LineGraphAreaConfig, PolyLinePoints } from '../helpers/rateModelLines';

type RateModelLoadingProps = {
  utilizationPoints?: PolyLinePoints;
  borrowPoints: PolyLinePoints;
  supplyPoints: PolyLinePoints;
  graphConfig: LineGraphAreaConfig;
};
export const RateModelLoadingView = ({
  utilizationPoints,
  borrowPoints,
  supplyPoints,
  graphConfig,
}: RateModelLoadingProps) => {
  const width = graphConfig.width;
  const height = graphConfig.height;

  return (
    <div className="interest-rate-model">
      {graphConfig.isV2Graph ? (
        <>
          <div className="interest-rate-model__keys">
            <label className="interest-rate-model__keys__item interest-rate-model__keys__item--utilization">
              Utilization
            </label>
            <label className="interest-rate-model__keys__item interest-rate-model__keys__item--borrow">
              Borrow APR
            </label>
            <label className="interest-rate-model__keys__item interest-rate-model__keys__item--supply">Earn APR</label>
          </div>

          <div className="interest-rate-model__keys interest-rate-model__keys--percentages">
            <label className="interest-rate-model__keys__item interest-rate-model__keys__item--utilization">--</label>
            <label className="interest-rate-model__keys__item interest-rate-model__keys__item--borrow">--</label>
            <label className="interest-rate-model__keys__item interest-rate-model__keys__item--supply">--</label>
          </div>
        </>
      ) : (
        <></>
      )}
      <div className="interest-rate-model__chart">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} ${height}`}>
          {utilizationPoints !== undefined ? (
            <>
              <polyline
                className="interest-rate-model__chart__line interest-rate-model__chart__line--utilization interest-rate-model__chart__line--utilization--lite"
                points={formatPoints(utilizationPoints)}
              />
            </>
          ) : (
            <></>
          )}

          {graphConfig.isV2Graph ? (
            <>
              <polyline
                className="interest-rate-model__chart__line interest-rate-model__chart__line--borrow-light"
                points={formatPoints(borrowPoints)}
              />

              <polyline
                className="interest-rate-model__chart__line interest-rate-model__chart__line--supply-light"
                points={formatPoints(supplyPoints)}
              />
            </>
          ) : (
            <>{getHorizontalLineMarkers(graphConfig)}</>
          )}
        </svg>
      </div>
    </div>
  );
};
