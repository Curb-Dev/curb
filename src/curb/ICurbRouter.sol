// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title ICurbRouter
 * @notice CurbRouter's ABI: every function, event and error it has, for
 *         whoever calls it - the tests, and anything else that wants a typed
 *         handle on the deployed router.
 *
 * WHY A SEPARATE FILE, AND WHY CurbRouter DOES NOT INHERIT IT
 *   The router is deployed with CREATE2, so its address is a hash of its
 *   bytecode, and it is compiled on its own (foundry.toml's compilation
 *   restriction) so nothing else in the project reaches that bytecode. A file
 *   that IMPORTS CurbRouter.sol is pulled into the router's compiler profile
 *   with everything it imports, so nothing does: the tests and the deploy
 *   script take the router from its build artifact and talk to it through
 *   this interface.
 *
 *   NOTHING KEEPS THIS IN STEP WITH THE CONTRACT BUT THE TESTS. They call
 *   every function through it, match every event by its selector, and expect
 *   every error by its selector, against the real router - so a signature
 *   that drifts here fails them.
 */
interface ICurbRouter {
    event BoughtWithEth(
        address indexed buyer,
        address indexed token,
        address indexed recipient,
        address registry,
        uint256 ethIn,
        uint256 quoteIn,
        uint256 tokensOut,
        uint256 quoteRefund,
        uint256 ethRefund
    );
    event SoldForEth(
        address indexed seller,
        address indexed token,
        address indexed recipient,
        address registry,
        uint256 tokensIn,
        uint256 quoteOut,
        uint256 ethOut,
        bool paidAsWeth
    );

    error Expired(uint256 deadline, uint256 timestamp);
    error ZeroRecipient();
    error RecipientIsTheRouter();
    error RecipientCannotBePaid(address recipient);
    error NoEthSent();
    error NotALaunch(address registry, address token);
    error PathOnWethLaunch();
    error MalformedPath(uint256 length);
    error PathStartsElsewhere(address first, address expected);
    error PathEndsElsewhere(address last, address expected);
    error NoQuoteMinimum();
    error NoEthMinimum();
    error QuoteBelowMinimum(uint256 received, uint256 minimum);
    error EthBelowMinimum(uint256 received, uint256 minimum);
    error RouteLeftInput(uint256 unspent);
    error RouteStoppedMidway(address asset, uint256 unspent);
    error IssuerForbids(address account, bytes32 policyScope, uint64 policyId);
    error BlacklistedBy(address asset, address account);
    error UnexpectedEth(address from);

    receive() external payable;

    function WETH() external view returns (address);
    function SWAP_ROUTER() external view returns (address);
    function B20_FACTORY() external view returns (address);
    function POLICY_REGISTRY() external view returns (address);

    function buyWithEth(
        address registry,
        address token,
        bytes calldata path,
        uint256 minQuoteOut,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline
    ) external payable returns (uint256 tokensOut);

    function sellForEth(
        address registry,
        address token,
        uint256 tokensIn,
        uint256 minQuoteOut,
        bytes calldata path,
        uint256 minEthOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 ethOut);
}
