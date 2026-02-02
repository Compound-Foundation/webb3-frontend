// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

interface Comet {
  struct AssetInfo {
    uint8 offset;
    address asset;
    address priceFeed;
    uint64 scale;
    uint64 borrowCollateralFactor;
    uint64 liquidateCollateralFactor;
    uint64 liquidationFactor;
    uint128 supplyCap;
  }

  struct TotalsBasic {
    uint64 baseSupplyIndex;
    uint64 baseBorrowIndex;
    uint64 trackingSupplyIndex;
    uint64 trackingBorrowIndex;
    uint104 totalSupplyBase;
    uint104 totalBorrowBase;
    uint40 lastAccrualTime;
    uint8 pauseFlags;
  }

  function quoteCollateral(address asset, uint baseAmount) external view returns (uint);

  function getAssetInfo(uint8 i) external view returns (AssetInfo memory);

  function getAssetInfoByAddress(address asset) external view returns (AssetInfo memory);

  function getCollateralReserves(address asset) external view returns (uint);

  function getReserves() external view returns (int);

  function getPrice(address priceFeed) external view returns (uint);

  function isBorrowCollateralized(address account) external view returns (bool);

  function isLiquidatable(address account) external view returns (bool);

  function totalSupply() external view returns (uint256);

  function totalBorrow() external view returns (uint256);

  function balanceOf(address owner) external view returns (uint256);

  function borrowBalanceOf(address account) external view returns (uint256);

  function getSupplyRate(uint utilization) external view returns (uint64);

  function getBorrowRate(uint utilization) external view returns (uint64);

  function getUtilization() external view returns (uint);

  function governor() external view returns (address);

  function pauseGuardian() external view returns (address);

  function baseToken() external view returns (address);

  function baseTokenPriceFeed() external view returns (address);

  function extensionDelegate() external view returns (address);

  function supplyKink() external view returns (uint);

  function supplyPerSecondInterestRateSlopeLow() external view returns (uint);

  function supplyPerSecondInterestRateSlopeHigh() external view returns (uint);

  function supplyPerSecondInterestRateBase() external view returns (uint);

  function borrowKink() external view returns (uint);

  function borrowPerSecondInterestRateSlopeLow() external view returns (uint);

  function borrowPerSecondInterestRateSlopeHigh() external view returns (uint);

  function borrowPerSecondInterestRateBase() external view returns (uint);

  function storeFrontPriceFactor() external view returns (uint);

  function baseScale() external view returns (uint);

  function trackingIndexScale() external view returns (uint);

  function baseTrackingSupplySpeed() external view returns (uint);

  function baseTrackingBorrowSpeed() external view returns (uint);

  function baseMinForRewards() external view returns (uint);

  function baseBorrowMin() external view returns (uint);

  function targetReserves() external view returns (uint);

  function numAssets() external view returns (uint8);

  function collateralBalanceOf(address account, address asset) external view returns (uint128);

  function baseTrackingAccrued(address account) external view returns (uint64);

  function baseAccrualScale() external view returns (uint64);

  function baseIndexScale() external view returns (uint64);

  function factorScale() external view returns (uint64);

  function priceScale() external view returns (uint64);

  function maxAssets() external view returns (uint8);

  function totalsBasic() external view returns (TotalsBasic memory);

  function totalsCollateral(address token) external view returns (uint);

  function allowance(address owner, address spender) external view returns (uint256);
}

interface ERC20 {
  function allowance(address owner, address spender) external view returns (uint);

  function balanceOf(address owner) external view returns (uint);

  function decimals() external view returns (uint);

  function name() external view returns (string memory);

  function symbol() external view returns (string memory);
}

contract CometQuery {
  uint internal constant SECONDS_PER_YEAR = 60 * 60 * 24 * 365;

  struct BaseAsset {
    address baseAsset;
    uint balanceOfComet;
    uint decimals;
    uint minBorrow;
    string name;
    address priceFeed;
    uint price;
    string symbol;
  }

  struct BaseAssetWithAccountState {
    address baseAsset;
    uint bulkerAllowance;
    uint allowance;
    int balance;
    uint balanceOfComet;
    uint decimals;
    uint minBorrow;
    string name;
    address priceFeed;
    uint price;
    string symbol;
    uint walletBalance;
  }

  struct CollateralAsset {
    address collateralAsset;
    uint collateralFactor;
    uint decimals;
    string name;
    uint liquidateCollateralFactor;
    uint liquidationFactor;
    uint price;
    address priceFeed;
    uint supplyCap;
    string symbol;
    uint totalSupply;
  }

  struct CollateralAssetWithAccountState {
    address collateralAsset;
    uint bulkerAllowance;
    uint allowance;
    uint balance;
    uint collateralFactor;
    uint decimals;
    string name;
    uint liquidateCollateralFactor;
    uint liquidationFactor;
    uint price;
    address priceFeed;
    uint supplyCap;
    string symbol;
    uint totalSupply;
    uint walletBalance;
  }

  struct CometStateWithoutCollateralAssets {
    BaseAsset baseAsset;
    uint baseMinForRewards;
    uint baseTrackingBorrowSpeed;
    uint baseTrackingSupplySpeed;
    uint borrowAPR;
    uint earnAPR;
    uint nativeAssetInDollars;
    uint totalBorrow;
    uint totalBorrowPrincipal;
    uint totalSupply;
    uint totalSupplyPrincipal;
    uint trackingIndexScale;
  }

  struct CometState {
    BaseAsset baseAsset;
    uint baseMinForRewards;
    uint baseTrackingBorrowSpeed;
    uint baseTrackingSupplySpeed;
    uint borrowAPR;
    CollateralAsset[] collateralAssets;
    uint earnAPR;
    uint nativeAssetInDollars;
    uint totalBorrow;
    uint totalBorrowPrincipal;
    uint totalSupply;
    uint totalSupplyPrincipal;
    uint trackingIndexScale;
  }

  struct CometStateWithAccountState {
    BaseAssetWithAccountState baseAsset;
    uint baseMinForRewards;
    uint baseTrackingBorrowSpeed;
    uint baseTrackingSupplySpeed;
    uint borrowAPR;
    uint bulkerAllowance;
    CollateralAssetWithAccountState[] collateralAssets;
    uint earnAPR;
    uint nativeAssetInDollars;
    uint nativeAssetWalletBalance;
    uint totalBorrow;
    uint totalBorrowPrincipal;
    uint totalSupply;
    uint totalSupplyPrincipal;
    uint trackingIndexScale;
  }

  function query(Comet comet, address nativeTokenToUsd, bool checkDeprecatedwUSDM) public view returns (CometState memory) {
    CometStateWithoutCollateralAssets memory response = cometStateMinusCollateralInfo(comet, nativeTokenToUsd);
    uint numAssets = comet.numAssets();

    CollateralAsset[] memory tokens = new CollateralAsset[](numAssets);
    for (uint8 i = 0; i < numAssets; i++) {
      tokens[i] = collateralInfo(comet, i, checkDeprecatedwUSDM);
    }

    return
      CometState({
        baseAsset: response.baseAsset,
        baseMinForRewards: response.baseMinForRewards,
        baseTrackingBorrowSpeed: response.baseTrackingBorrowSpeed,
        baseTrackingSupplySpeed: response.baseTrackingSupplySpeed,
        borrowAPR: response.borrowAPR,
        collateralAssets: tokens,
        earnAPR: response.earnAPR,
        nativeAssetInDollars: response.nativeAssetInDollars,
        totalBorrow: response.totalBorrow,
        totalBorrowPrincipal: response.totalBorrowPrincipal,
        totalSupply: response.totalSupply,
        totalSupplyPrincipal: response.totalSupplyPrincipal,
        trackingIndexScale: response.trackingIndexScale
      });
  }

  function queryWithAccount(
    Comet comet,
    address nativeTokenToUsd,
    address payable account,
    address payable bulker,
    string memory wrappedNativeTokenSymbol,
    bool checkDeprecatedwUSDM
  ) public view returns (CometStateWithAccountState memory) {
    CometState memory response = query(comet, nativeTokenToUsd, checkDeprecatedwUSDM);

    uint baseAssetSupplyBalance = comet.balanceOf(account);
    uint baseAssetBorrowBalance = comet.borrowBalanceOf(account);

    uint walletBalance = ERC20(response.baseAsset.baseAsset).balanceOf(account);

    if (compare(response.baseAsset.symbol, wrappedNativeTokenSymbol)) {
      walletBalance = account.balance;
    }

    BaseAssetWithAccountState memory baseAsset = BaseAssetWithAccountState({
      baseAsset: response.baseAsset.baseAsset,
      bulkerAllowance: ERC20(response.baseAsset.baseAsset).allowance(account, bulker),
      allowance: ERC20(response.baseAsset.baseAsset).allowance(account, address(comet)),
      balance: int(baseAssetSupplyBalance) - int(baseAssetBorrowBalance),
      symbol: response.baseAsset.symbol,
      decimals: response.baseAsset.decimals,
      minBorrow: response.baseAsset.minBorrow,
      name: response.baseAsset.name,
      priceFeed: response.baseAsset.priceFeed,
      price: response.baseAsset.price,
      balanceOfComet: response.baseAsset.balanceOfComet,
      walletBalance: walletBalance
    });

    CollateralAssetWithAccountState[] memory tokens = new CollateralAssetWithAccountState[](
      response.collateralAssets.length
    );
    for (uint8 i = 0; i < response.collateralAssets.length; i++) {
      tokens[i] = collateralInfoWithAccount(comet, bulker, response.collateralAssets[i], account, wrappedNativeTokenSymbol);
    }

    return
      CometStateWithAccountState({
        baseAsset: baseAsset,
        baseMinForRewards: response.baseMinForRewards,
        baseTrackingBorrowSpeed: response.baseTrackingBorrowSpeed,
        baseTrackingSupplySpeed: response.baseTrackingSupplySpeed,
        borrowAPR: response.borrowAPR,
        bulkerAllowance: comet.allowance(account, bulker),
        collateralAssets: tokens,
        earnAPR: response.earnAPR,
        nativeAssetInDollars: response.nativeAssetInDollars,
        nativeAssetWalletBalance: account.balance,
        totalBorrow: response.totalBorrow,
        totalBorrowPrincipal: response.totalBorrowPrincipal,
        totalSupply: response.totalSupply,
        totalSupplyPrincipal: response.totalSupplyPrincipal,
        trackingIndexScale: response.trackingIndexScale
      });
  }

  function cometStateMinusCollateralInfo(Comet comet, address nativeTokenToUsd) public view returns (CometStateWithoutCollateralAssets memory) {
    address baseToken = comet.baseToken();
    address baseTokenPriceFeed = comet.baseTokenPriceFeed();
    uint borrowMin = comet.baseBorrowMin();
    uint trackingIndexScale = comet.trackingIndexScale();
    uint baseTrackingSupplySpeed = comet.baseTrackingSupplySpeed();
    uint baseTrackingBorrowSpeed = comet.baseTrackingBorrowSpeed();
    uint baseMinForRewards = comet.baseMinForRewards();
    uint utilization = comet.getUtilization();
    uint nativeAssetInDollars = comet.getPrice(nativeTokenToUsd);
    uint totalSupply = comet.totalSupply();
    uint totalBorrow = comet.totalBorrow();
    Comet.TotalsBasic memory totalsBasic = comet.totalsBasic();
    uint borrowRatePerSecond = comet.getBorrowRate(utilization);
    uint supplyRatePerSecond = comet.getSupplyRate(utilization);

    BaseAsset memory baseAsset = BaseAsset({
      baseAsset: baseToken,
      symbol: ERC20(baseToken).symbol(),
      decimals: ERC20(baseToken).decimals(),
      minBorrow: borrowMin,
      name: ERC20(baseToken).name(),
      priceFeed: baseTokenPriceFeed,
      price: comet.getPrice(baseTokenPriceFeed),
      balanceOfComet: ERC20(baseToken).balanceOf(address(comet))
    });

    return
      CometStateWithoutCollateralAssets({
        baseAsset: baseAsset,
        baseMinForRewards: baseMinForRewards,
        baseTrackingBorrowSpeed: baseTrackingBorrowSpeed,
        baseTrackingSupplySpeed: baseTrackingSupplySpeed,
        borrowAPR: borrowRatePerSecond * SECONDS_PER_YEAR,
        earnAPR: supplyRatePerSecond * SECONDS_PER_YEAR,
        nativeAssetInDollars: nativeAssetInDollars,
        totalBorrow: totalBorrow,
        totalBorrowPrincipal: totalsBasic.totalBorrowBase,
        totalSupply: totalSupply,
        totalSupplyPrincipal: totalsBasic.totalSupplyBase,
        trackingIndexScale: trackingIndexScale
      });
  }

  function collateralInfo(Comet comet, uint8 index, bool checkDeprecatedwUSDM) public view returns (CollateralAsset memory) {
    Comet.AssetInfo memory assetInfo = comet.getAssetInfo(index);

    if (checkDeprecatedwUSDM && 
      ( 0xe3a409eD15CD53aFdEFdd191ad945cEC528A2496 == assetInfo.priceFeed 
      || 0x13cDFB7db5e2F58e122B2e789b59dE13645349C4 == assetInfo.priceFeed
      || 0x66228d797eb83ecf3465297751f6b1D4d42b7627 == assetInfo.priceFeed
      || 0x7E86318Cc4bc539043F204B39Ce0ebeD9F0050Dc == assetInfo.priceFeed)
    ) {
      return
        CollateralAsset({
          collateralAsset: assetInfo.asset,
          collateralFactor: assetInfo.borrowCollateralFactor,
          decimals: ERC20(assetInfo.asset).decimals(),
          liquidateCollateralFactor: assetInfo.liquidateCollateralFactor,
          liquidationFactor: assetInfo.liquidationFactor,
          name: ERC20(assetInfo.asset).name(),
          price: 0,
          priceFeed: assetInfo.priceFeed,
          supplyCap: assetInfo.supplyCap,
          symbol: ERC20(assetInfo.asset).symbol(),
          totalSupply: comet.totalsCollateral(assetInfo.asset)
        });
    } else {
      return
      CollateralAsset({
        collateralAsset: assetInfo.asset,
        collateralFactor: assetInfo.borrowCollateralFactor,
        decimals: ERC20(assetInfo.asset).decimals(),
        liquidateCollateralFactor: assetInfo.liquidateCollateralFactor,
        liquidationFactor: assetInfo.liquidationFactor,
        name: ERC20(assetInfo.asset).name(),
        price: comet.getPrice(assetInfo.priceFeed),
        priceFeed: assetInfo.priceFeed,
        supplyCap: assetInfo.supplyCap,
        symbol: ERC20(assetInfo.asset).symbol(),
        totalSupply: comet.totalsCollateral(assetInfo.asset)
      });
    }
  }

  function collateralInfoWithAccount(
    Comet comet,
    address payable bulker,
    CollateralAsset memory asset,
    address payable account,
    string memory wrappedNativeTokenSymbol
  ) public view returns (CollateralAssetWithAccountState memory) {
    uint walletBalance = ERC20(asset.collateralAsset).balanceOf(account);
    if (compare(asset.symbol, wrappedNativeTokenSymbol)) {
      walletBalance = account.balance;
    }

    return
      CollateralAssetWithAccountState({
        collateralAsset: asset.collateralAsset,
        bulkerAllowance: ERC20(asset.collateralAsset).allowance(account, bulker),
        allowance: ERC20(asset.collateralAsset).allowance(account, address(comet)),
        balance: comet.collateralBalanceOf(account, asset.collateralAsset),
        collateralFactor: asset.collateralFactor,
        decimals: asset.decimals,
        liquidateCollateralFactor: asset.liquidateCollateralFactor,
        liquidationFactor: asset.liquidationFactor,
        name: asset.name,
        price: asset.price,
        priceFeed: asset.priceFeed,
        supplyCap: asset.supplyCap,
        symbol: asset.symbol,
        totalSupply: asset.totalSupply,
        walletBalance: walletBalance
      });
  }

  function compare(string memory str1, string memory str2) internal pure returns (bool) {
    if (bytes(str1).length != bytes(str2).length) {
      return false;
    }
    return keccak256(abi.encodePacked(str1)) == keccak256(abi.encodePacked(str2));
  }
}
