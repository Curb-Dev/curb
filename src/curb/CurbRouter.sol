// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @dev The part of LaunchRegistry this router reads.
///
///      DECLARED HERE RATHER THAN IMPORTED, and that is about the ADDRESS. This
///      contract is deployed with CREATE2, so its address is a hash of its
///      bytecode. The router is compiled without the metadata hash (see
///      foundry.toml), so comments and file paths no longer reach the
///      bytecode - but code in an imported file still would, and a registry
///      edit made for the registry's sake must not move the router. The
///      record's layout is written once per registry and cannot change under
///      a live one; the tuple below is that layout, field for field.
interface ILaunchBook {
    struct LaunchRecord {
        address curve;
        address quoteToken;
        address beneficiary;
        address refundTo;
        uint256 lockDuration;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        uint16 totalTaxBps;
        uint16 platformBps;
        address platformRecipient;
    }

    function isRegistered(address launchToken) external view returns (bool);
    function launchOf(address launchToken) external view returns (LaunchRecord memory);
}

/// @dev The two trades of PonsV2BondingCurve this router makes.
interface ILaunchCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

/// @dev Uniswap's SwapRouter02 (IV3SwapRouter). Its exactInput takes NO
///      deadline - that lives in its multicall - so the deadline is checked
///      here, once, for the whole call.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev The two calls this router makes to Base's WETH9 beyond ERC-20.
///      DECLARED HERE, not imported from src/curb/IWETH.sol: that file is
///      shared with FeeHook and FeeEscrow, and nothing changed there for their
///      sake may move this contract's address.
interface IWrappedEther {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev Base's B20 factory precompile: whether an address is a B20 token.
interface IB20Lookup {
    function isB20(address token) external view returns (bool);
}

/// @dev The part of a B20 token that names its issuer's transfer policies.
interface IB20Policies {
    function TRANSFER_SENDER_POLICY() external view returns (bytes32);
    function TRANSFER_RECEIVER_POLICY() external view returns (bytes32);
    function policyId(bytes32 policyScope) external view returns (uint64);
}

/// @dev Base's policy registry precompile, which B20 asks on every transfer.
interface IPolicyLookup {
    function isAuthorized(uint64 policyId, address account) external view returns (bool);
}

/// @dev The question a FiatToken-style asset answers about its own blacklist
///      (Coinbase's cbBTC and cbXRP on Base). Only its selector is used.
interface IBlacklistLookup {
    function isBlacklisted(address account) external view returns (bool);
}

/**
 * @title CurbRouter
 * @notice ETH in, launch tokens out - and launch tokens in, ETH out - in ONE
 *         transaction, on any pair.
 *
 * WHY THIS EXISTS
 *   A curve takes and pays only its own quote asset, and a wallet holds ETH.
 *   Without this, paying ETH for a curve buy was three confirmations on every
 *   pair (wrap or swap, approve, buy) and a sale that pays ETH was three more
 *   (approve, sell, unwrap) - and a stock pair's sale could not pay ETH at
 *   all. The owner's word for it was "too many confirmations", and a buyer
 *   who is asked to sign three times for one purchase has every reason to
 *   wonder what the other two are for.
 *
 *   Now a buy is ONE confirmation on every pair, and a sale is two: approve
 *   this router for exactly the sale, then sell. The launch token has no
 *   permit, so that approval cannot be folded into a signature - but the
 *   sale pays ETH on every pair, stock pairs included.
 *
 * WHAT IT CAN TOUCH: THE CALLER'S OWN MONEY, IN THIS TRANSACTION
 *   There is no owner, no administrator, no setter, no pause and no storage.
 *   WETH, SwapRouter02 and Base's two precompiles are constants, not
 *   constructor arguments - which is also what lets the same bytecode land at
 *   the same address on Base and on any fork of it. Everything this contract
 *   moves is either the ETH sent with the call or tokens pulled from
 *   msg.sender with transferFrom; there is no argument anywhere that names
 *   somebody else's balance to pull from. Nothing is kept between
 *   transactions: every amount below is a measured delta, so a balance
 *   already sitting here - however it got here - is neither spent on the
 *   caller's behalf nor handed to them.
 *
 * IT IS NOT A DEPOSIT ADDRESS
 *   The other side of the rule above: anything sent here outside a call -
 *   tokens, WETH, ether forced in - stays here for good. No function pays
 *   out more than the caller's own delta, and there is no sweep, because a
 *   sweep would raise the question of whose it is. The same holds for a
 *   launch that names this router as its quoteRefundTo or its beneficiary:
 *   that refund, or those fees, are lost - or, when graduation happens inside
 *   a crossing buy made through this router, counted into that buyer's
 *   refund. The page refuses this address in the create form.
 *
 * THE REGISTRY IS AN ARGUMENT, AND THAT IS SAFE BECAUSE OF THE ABOVE
 *   The curve and the quote asset are read from the registry the caller
 *   names, never taken from the caller directly, and a token that registry
 *   does not know is refused. A caller who names a wrong registry - or one
 *   that lies - can send their own ETH or tokens to a wrong curve, and nobody
 *   else's: the router holds nothing of anybody else's to lose. What the page
 *   must do is name the right one.
 *
 * NOT A WAY AROUND THE ISSUER
 *   A stock asset is a B20 token whose issuer decides, per address, who may
 *   send it and who may receive it; cbBTC and cbXRP are Coinbase tokens with
 *   a blacklist of their own. Through this router the caller never holds the
 *   asset - the pool, the router and the curve pass it between them - so the
 *   asset's own checks only ever see the router. Left at that, an account
 *   the issuer has refused could trade every such pair here, and the
 *   issuer's natural answer, refusing the router, would stop every ETH trade
 *   on every such pair for everybody. So the router asks the issuer's rule
 *   itself, before anything moves, of the caller, the router and the
 *   recipient - the recipient always, and the caller on a sale, going beyond
 *   what a trade by hand needs: see _checkIssuer.
 *
 * NO ALLOWANCE IS LEFT STANDING
 *   Every approval is for the exact amount about to be spent, and each one is
 *   taken back afterwards if anything is left of it. The real curve spends its
 *   allowance to the wei, so that is for a curve that does not - see above -
 *   and for SwapRouter02's habit of paying with ETH it already holds instead
 *   of pulling the WETH it was approved for.
 *
 * WHAT IT DOES NOT DO
 *   It does not trade a graduated launch: the curve refuses, and the pool is
 *   reached through Uniswap's own router, which already takes ETH in one
 *   transaction. It does not choose the route: the caller passes the v3 path
 *   the page priced, and this contract only checks that it starts and ends
 *   where it must, and that every hop of it took all it was given. It does
 *   not put a price on anything - every bound is the caller's, and the ones
 *   that guard a swap may not be left at zero.
 */
contract CurbRouter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// Base's WETH9.
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    /// Uniswap's SwapRouter02 on Base. VERIFIED on the fork of Base at block
    /// 51171034 before it was written here: code present, WETH9() is the WETH
    /// above, factory() is the v3 factory the page prices against, and the
    /// bytecode carries exactInput((bytes,address,uint256,uint256)) and not the
    /// older five-field variant with a deadline.
    address public constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    /// Base's B20 factory precompile, asked whether a quote asset is a B20.
    address public constant B20_FACTORY = 0xB20f000000000000000000000000000000000000;
    /// Base's policy registry precompile, the one B20 itself asks.
    address public constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002;

    /// A v3 path is a token, then a 3-byte fee and a token per hop.
    uint256 private constant ADDR = 20;
    uint256 private constant HOP = 23;
    /// The most gas one blacklist question may spend - see _notBlacklisted.
    uint256 private constant PROBE_GAS = 100_000;

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
    /// WETH, SwapRouter02, or the launch's own curve, token or quote asset:
    /// an address that would keep the payout, or leave it for anybody.
    error RecipientCannotBePaid(address recipient);
    error NoEthSent();
    error NotALaunch(address registry, address token);
    /// A WETH launch needs no swap, and a path passed for one means the caller
    /// thinks it is trading some other pair.
    error PathOnWethLaunch();
    error MalformedPath(uint256 length);
    error PathStartsElsewhere(address first, address expected);
    error PathEndsElsewhere(address last, address expected);
    /// A buy that swaps was sent with minQuoteOut zero.
    error NoQuoteMinimum();
    /// A sale was sent with minEthOut zero.
    error NoEthMinimum();
    error QuoteBelowMinimum(uint256 received, uint256 minimum);
    error EthBelowMinimum(uint256 received, uint256 minimum);
    /// The route took only part of what the curve paid out.
    error RouteLeftInput(uint256 unspent);
    /// A later hop of the route took only part of what the hop before it
    /// delivered, and `unspent` of `asset` was left on SwapRouter02.
    error RouteStoppedMidway(address asset, uint256 unspent);
    /// The quote asset's issuer does not let `account` send or receive it.
    error IssuerForbids(address account, bytes32 policyScope, uint64 policyId);
    /// The quote asset - one with a blacklist of its own, such as cbBTC or
    /// cbXRP - has `account` on that list.
    error BlacklistedBy(address asset, address account);
    error UnexpectedEth(address from);

    /// @notice Accepts ETH from WETH alone - the unwraps this contract makes.
    /// @dev Anything else would sit here with nothing to say whose it is.
    receive() external payable {
        if (msg.sender != WETH) revert UnexpectedEth(msg.sender);
    }

    // ------------------------------------------------------------------
    // ETH -> launch token
    // ------------------------------------------------------------------

    /// @notice Buys `token` on its curve with the ETH sent, in one transaction.
    /// @param registry The LaunchRegistry the launch is recorded in.
    /// @param token The launch token.
    /// @param path The v3 path from WETH to the launch's quote asset. Empty on
    ///        a WETH launch, which needs no swap.
    /// @param minQuoteOut The least quote asset the swap may deliver. On a
    ///        WETH launch the quote IS the ETH sent. On any other launch it
    ///        must not be zero: it is the ONLY bound on the swap. Take it from
    ///        a fresh quote with slippage applied. minTokensOut does not cover
    ///        the swap on the buy that crosses the threshold, because there it
    ///        bounds the curve's price and not the amount, so a sandwich that
    ///        shrinks the swap would only shrink the caller's refund.
    /// @param minTokensOut The curve's own bound, passed through unchanged. On
    ///        the buy that fills a launch it bounds the PRICE, not the amount -
    ///        see PonsV2BondingCurve.buy.
    /// @param recipient Who receives the launch tokens.
    /// @param deadline Refused after this timestamp.
    /// @return tokensOut What the curve delivered to `recipient`.
    ///
    /// @dev WHAT COMES BACK GOES TO THE CALLER. A buy past the graduation
    ///      threshold is filled only up to it and the curve refunds the rest
    ///      here: on a WETH launch it leaves as ETH (WETH if the caller will not
    ///      take ETH), on any other it leaves as the quote asset, which is what
    ///      the curve refunded. WETH the FIRST hop did not take comes back the
    ///      same way. A later hop that stops short reverts the whole buy - see
    ///      _checkMidway.
    function buyWithEth(
        address registry,
        address token,
        bytes calldata path,
        uint256 minQuoteOut,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 tokensOut) {
        _checkCall(deadline, recipient);
        if (msg.value == 0) revert NoEthSent();
        (address curve, address quote) = _launch(registry, token, recipient);
        _checkRoute(path, WETH, quote);
        if (quote != WETH && minQuoteOut == 0) revert NoQuoteMinimum();
        _checkIssuer(quote, recipient);

        // BALANCES BEFORE ANYTHING ARRIVES. Every amount below is measured
        // against these, so nothing already here is counted as the caller's.
        uint256 wethStart = IERC20(WETH).balanceOf(address(this));
        uint256 quoteStart = quote == WETH ? wethStart : IERC20(quote).balanceOf(address(this));

        IWrappedEther(WETH).deposit{value: msg.value}();

        uint256 quoteIn;
        if (quote == WETH) {
            quoteIn = msg.value;
        } else {
            uint256[] memory midway = _heldMidway(path);
            IERC20(WETH).forceApprove(SWAP_ROUTER, msg.value);
            // NO MINIMUM HANDED TO SWAPROUTER02. The bound is applied just
            // below, once, to what actually ARRIVED here - which is the amount
            // the curve is offered, and so the one that matters.
            ISwapRouter02(SWAP_ROUTER).exactInput(
                ISwapRouter02.ExactInputParams({
                    path: path, recipient: address(this), amountIn: msg.value, amountOutMinimum: 0
                })
            );
            // SWAPROUTER02 PAYS A WETH LEG WITH ITS OWN ETH WHEN IT HOLDS
            // ENOUGH, and then never pulls the WETH it was approved for. Stray
            // ETH on it is anybody's, so that is a real state; the WETH it did
            // not pull is refunded below and the allowance is taken back here.
            _clearAllowance(WETH, SWAP_ROUTER);
            _checkMidway(path, midway);
            quoteIn = IERC20(quote).balanceOf(address(this)) - quoteStart;
        }
        if (quoteIn < minQuoteOut) revert QuoteBelowMinimum(quoteIn, minQuoteOut);

        IERC20(quote).forceApprove(curve, quoteIn);
        tokensOut = ILaunchCurve(curve).buy(quoteIn, minTokensOut, recipient);
        _clearAllowance(quote, curve);

        // ---- what comes back. The asset first, the ETH last, so the only
        // external call made with ETH attached is the final one.
        uint256 quoteRefund;
        if (quote != WETH) {
            quoteRefund = IERC20(quote).balanceOf(address(this)) - quoteStart;
            if (quoteRefund != 0) IERC20(quote).safeTransfer(msg.sender, quoteRefund);
        }
        uint256 ethRefund = IERC20(WETH).balanceOf(address(this)) - wethStart;
        if (ethRefund != 0) _payEth(msg.sender, ethRefund);

        emit BoughtWithEth(
            msg.sender, token, recipient, registry, msg.value, quoteIn, tokensOut, quoteRefund, ethRefund
        );
    }

    // ------------------------------------------------------------------
    // launch token -> ETH
    // ------------------------------------------------------------------

    /// @notice Sells `tokensIn` of the caller's `token` to its curve and pays
    ///         ETH to `recipient`, in one transaction.
    /// @dev The caller approves THIS contract for exactly `tokensIn` first.
    ///      The tokens come from msg.sender and nobody else: there is no
    ///      parameter that names whose tokens to take, and no more than
    ///      `tokensIn` is taken whatever the approval says.
    /// @param minQuoteOut The curve's own bound on what the sale pays.
    /// @param path The v3 path from the quote asset to WETH. Empty on a WETH
    ///        launch.
    /// @param minEthOut The least ETH `recipient` may receive. Never zero: on
    ///        a stock pair it is the only bound on the swap, and on any pair a
    ///        page that sends zero has not priced the sale at all.
    /// @return ethOut What `recipient` was paid, as ETH or as WETH.
    function sellForEth(
        address registry,
        address token,
        uint256 tokensIn,
        uint256 minQuoteOut,
        bytes calldata path,
        uint256 minEthOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 ethOut) {
        _checkCall(deadline, recipient);
        (address curve, address quote) = _launch(registry, token, recipient);
        _checkRoute(path, quote, WETH);
        if (minEthOut == 0) revert NoEthMinimum();
        _checkIssuer(quote, recipient);

        uint256 wethStart = IERC20(WETH).balanceOf(address(this));
        uint256 quoteStart = quote == WETH ? wethStart : IERC20(quote).balanceOf(address(this));

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(token).forceApprove(curve, tokensIn);
        // TO THIS CONTRACT, not to the recipient: the proceeds still have to
        // become ETH, and on a stock pair they have a swap to go through first.
        ILaunchCurve(curve).sell(tokensIn, minQuoteOut, address(this));
        _clearAllowance(token, curve);
        uint256 quoteOut = IERC20(quote).balanceOf(address(this)) - quoteStart;

        if (quote == WETH) {
            ethOut = quoteOut;
        } else {
            uint256[] memory midway = _heldMidway(path);
            IERC20(quote).forceApprove(SWAP_ROUTER, quoteOut);
            // The bound is on the ETH, below, measured - not on this leg.
            ISwapRouter02(SWAP_ROUTER).exactInput(
                ISwapRouter02.ExactInputParams({
                    path: path, recipient: address(this), amountIn: quoteOut, amountOutMinimum: 0
                })
            );
            // ALL OF IT OR NONE OF IT, ON THE FIRST HOP. A v3 pool that runs
            // out of range before the input is used up takes only part and
            // returns, and SwapRouter02 does not object. What the first hop
            // left is still here, and paying it out would pay the recipient in
            // two assets they did not ask for, so the route is refused. Nothing
            // is left unpulled, so no allowance is left standing either.
            uint256 unspent = IERC20(quote).balanceOf(address(this)) - quoteStart;
            if (unspent != 0) revert RouteLeftInput(unspent);
            // AND ON EVERY LATER HOP, where the remainder is not here at all.
            _checkMidway(path, midway);
            ethOut = IERC20(WETH).balanceOf(address(this)) - wethStart;
        }
        if (ethOut < minEthOut) revert EthBelowMinimum(ethOut, minEthOut);

        bool asWeth = _payEth(recipient, ethOut);
        emit SoldForEth(msg.sender, token, recipient, registry, tokensIn, quoteOut, ethOut, asWeth);
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    function _checkCall(uint256 deadline, address recipient) private view {
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        // The curve refuses a zero recipient on a buy by itself; on a sale the
        // recipient is only ever this contract's to pay, and a call to address
        // zero SUCCEEDS - the ETH would simply be gone.
        if (recipient == address(0)) revert ZeroRecipient();
        // NOR THIS CONTRACT. It has no way to hand anything on, and every
        // amount it moves is a delta, so tokens or WETH paid to itself would
        // sit here for good. One page bug away from real, so refused.
        if (recipient == address(this)) revert RecipientIsTheRouter();
        // NOR WETH, WHICH HAS THE SAME EFFECT: ether sent to it is deposited
        // for the sender - this contract - and stays here. NOR SWAPROUTER02:
        // it refuses ether, so the payout would fall back to WETH sitting on
        // it, which anybody can sweep.
        if (recipient == WETH || recipient == SWAP_ROUTER) revert RecipientCannotBePaid(recipient);
    }

    /// THE CURVE AND THE QUOTE ASSET COME FROM THE REGISTRY, never from the
    /// caller. Asked first whether it knows the token at all, so a token it
    /// does not know is refused here, by name, rather than by whatever a
    /// registry happens to do with a missing record. The recipient may not be
    /// the launch's own curve, token or quote asset: none of them hands
    /// anything on.
    function _launch(address registry, address token, address recipient)
        private
        view
        returns (address curve, address quote)
    {
        if (!ILaunchBook(registry).isRegistered(token)) revert NotALaunch(registry, token);
        ILaunchBook.LaunchRecord memory rec = ILaunchBook(registry).launchOf(token);
        (curve, quote) = (rec.curve, rec.quoteToken);
        if (recipient == curve || recipient == token || recipient == quote) revert RecipientCannotBePaid(recipient);
    }

    /// CHECKED BEFORE ANYTHING MOVES. One side of every route is WETH; when
    /// the other side is WETH too there is nothing to swap, and the path must
    /// be empty rather than quietly ignored.
    ///
    /// Otherwise BOTH ENDS, AND THE SHAPE BETWEEN THEM. The length check is not
    /// decoration: SwapRouter02 walks a path in 23-byte steps from the front,
    /// so on a path of any other length the last twenty bytes are NOT the token
    /// it pays out in, and checking them would check the wrong address.
    function _checkRoute(bytes calldata path, address first, address last) private pure {
        if (first == last) {
            if (path.length != 0) revert PathOnWethLaunch();
            return;
        }
        if (path.length < ADDR + HOP || (path.length - ADDR) % HOP != 0) revert MalformedPath(path.length);
        address from = address(bytes20(path[:ADDR]));
        address to = address(bytes20(path[path.length - ADDR:]));
        if (from != first) revert PathStartsElsewhere(from, first);
        if (to != last) revert PathEndsElsewhere(to, last);
    }

    /// THE ISSUER'S OWN RULE, ASKED BEFORE ANYTHING MOVES.
    ///
    /// TWO KINDS OF RULE. A B20 (the stocks, cbZEC) names a sender and a
    /// receiver policy that Base's policy registry answers. cbBTC and cbXRP
    /// are not B20s: they are Coinbase FiatToken proxies with one blacklist,
    /// kept by the token's blacklister, and their transfer and transferFrom
    /// refuse a blacklisted msg.sender, from or to (measured on the fork of
    /// Base, with a real entry made by each token's blacklister). WETH9 has
    /// neither. Each kind is asked of the same three accounts.
    ///
    /// WHO IS ASKED, AND HOW THAT COMPARES WITH A TRADE BY HAND.
    ///   THE ROUTER, because it really does receive and send the asset. A
    ///   refused router fails here by name, with nothing moved, instead of
    ///   deep inside a v3 pool whose TransferHelper turns the asset's refusal
    ///   into an unreadable "TF".
    ///   THE CALLER ON A BUY: exactly what a trade by hand implies. The curve
    ///   takes the asset from msg.sender, so by hand the buyer must receive it
    ///   (from the pool) and send it (to the curve), and the asset refuses
    ///   both to an account it has refused (measured on cbBTC and cbXRP: a
    ///   blacklisted buyer's swap to themselves reverts inside the pool).
    ///   THE CALLER ON A SALE: STRICTER THAN BY HAND. By hand a seller the
    ///   issuer refuses can still sell without ever holding the asset: have
    ///   the curve pay SwapRouter02 directly - curve.sell(tokens, 0,
    ///   SwapRouter02) - then swap SwapRouter02's own balance with
    ///   exactInput's amountIn of 0 (CONTRACT_BALANCE), paying themselves WETH
    ///   (measured on the fork, on NVDAc's blocklist and on cbBTC's and
    ///   cbXRP's blacklists). The asset then only ever moves from the curve to
    ///   SwapRouter02 to the pool, and nothing it checks is the seller.
    ///   Through this router the same sale reverts naming the seller. That is
    ///   kept on purpose: the router is one contract every seller shares, and
    ///   an issuer that saw refused accounts leave through it would refuse the
    ///   router itself, which stops every ETH trade on that pair for everybody.
    ///   THE RECIPIENT: STRICTER THAN BY HAND, on both sides. By hand a
    ///   recipient the issuer refuses never touches the asset - a buy for
    ///   them gives them only launch tokens, a sale for them pays them only
    ///   ETH - and both succeed (measured, on NVDAc's blocklist). Through this
    ///   router the same trades revert naming the recipient: the router does
    ///   not deliver an issuer's pair, or the ETH from selling one, to an
    ///   account that issuer has refused.
    ///
    /// THE EXECUTOR POLICY IS NOT ASKED, on purpose. B20 applies
    /// TRANSFER_EXECUTOR_POLICY to whoever CALLS transfer or transferFrom -
    /// the contract moving the tokens. By hand that is the pool, SwapRouter02
    /// and the curve, never the user, so a user refused only as an executor
    /// can still make this trade by hand, and refusing them here would be a
    /// rule the issuer did not set. Through the router the executors are the
    /// same contracts plus the router itself for the asset refund, and B20
    /// checks every one of them on every transfer, reverting with
    /// PolicyForbids. (A FiatToken has one list for every role, so its
    /// executor is the router, which is asked.)
    ///
    /// WHICH ASSETS. WETH is skipped by its address: it has no issuer, it is
    /// the main pair, and probing it would be the worst case of all (see
    /// _notBlacklisted). For anything else the B20 factory says whether it is
    /// a B20. If it is, its policies are asked, and no lookup there fails
    /// open: a factory that cannot answer, or answers with anything but a
    /// bool, reverts the trade, and so does a policy registry that cannot
    /// answer. A B20 with no transfer policy names policy 0, which the
    /// registry authorizes for every address (measured on the fork of Base),
    /// so such an asset trades as it would by hand. If it is not a B20, the
    /// asset is asked isBlacklisted of each account, and that question DOES
    /// fail open, rightly: a token without the function has no blacklist.
    ///
    /// WHAT IT COSTS, measured on the fork: about 10,000 to 12,000 gas on a
    /// stock pair (the factory, four reads of the token, six of the
    /// registry); on a cbBTC or cbXRP pair the factory's no plus about 8,800
    /// on a buy and 6,800 on a sale for the three blacklist questions
    /// (against the same build with them taken out); and nothing on the WETH
    /// pair, which no longer asks even the factory.
    function _checkIssuer(address quote, address recipient) private view {
        if (quote == WETH) return;
        if (!IB20Lookup(B20_FACTORY).isB20(quote)) {
            _notBlacklisted(quote, msg.sender);
            _notBlacklisted(quote, recipient);
            _notBlacklisted(quote, address(this));
            return;
        }
        bytes32 sendScope = IB20Policies(quote).TRANSFER_SENDER_POLICY();
        bytes32 receiveScope = IB20Policies(quote).TRANSFER_RECEIVER_POLICY();
        uint64 sendPolicy = IB20Policies(quote).policyId(sendScope);
        uint64 receivePolicy = IB20Policies(quote).policyId(receiveScope);
        _admitted(msg.sender, sendScope, sendPolicy, receiveScope, receivePolicy);
        _admitted(recipient, sendScope, sendPolicy, receiveScope, receivePolicy);
        _admitted(address(this), sendScope, sendPolicy, receiveScope, receivePolicy);
    }

    function _admitted(address account, bytes32 sendScope, uint64 sendPolicy, bytes32 receiveScope, uint64 receivePolicy)
        private
        view
    {
        if (!IPolicyLookup(POLICY_REGISTRY).isAuthorized(sendPolicy, account)) {
            revert IssuerForbids(account, sendScope, sendPolicy);
        }
        if (!IPolicyLookup(POLICY_REGISTRY).isAuthorized(receivePolicy, account)) {
            revert IssuerForbids(account, receiveScope, receivePolicy);
        }
    }

    /// ONE BLACKLIST QUESTION: asset.isBlacklisted(account). Only an answer
    /// that is a true bool - at least 32 bytes, the first word exactly 1,
    /// which is what a typed call would decode as true - refuses the trade.
    /// A call that reverts, runs out of its gas, or answers anything else
    /// (nothing, a short answer, a word that is not 0 or 1) means the asset
    /// keeps no such list, and the trade goes on: a token without the
    /// function has no blacklist to get around.
    ///
    /// NOTHING A QUOTE ASSET DOES HERE CAN REVERT THE TRADE except answering
    /// true. It is a static call, so it cannot change anything. Its answer
    /// is never copied: only the first word lands in scratch space, so an
    /// asset that answers megabytes costs nothing to read. And its gas is
    /// capped at PROBE_GAS, so an asset whose fallback burns everything
    /// takes at most that, three times, and the trade still has the rest.
    ///
    /// WHY 100,000. The cap is a ceiling, not a price: an asset that answers
    /// pays only what it uses. On the fork a cold question to cbBTC or cbXRP
    /// spends about 7,300 gas of it (the proxy's implementation slot, the
    /// cold implementation, the account's entry - traced through the router,
    /// with both accounts made cold), a warm one about 1,300, and the router
    /// pays 2,600 more itself, outside the cap, to reach a cold proxy. The
    /// cap leaves more than ten times the cold cost, because running out of
    /// it would make the check fail OPEN in a contract that cannot be
    /// changed: it has room for a repricing of cold state access, or a
    /// heavier implementation behind the same proxy. WETH9 is the one asset
    /// whose fallback burns the whole cap - it deposits, which a static call
    /// cannot do, so the call halts with all its gas spent (measured: a cap
    /// of 30,000 spent in full; with the skip taken out, every WETH trade
    /// through this router cost 301,000 gas more) - so it is skipped by
    /// address before it is asked. B20s reach the policy check instead, and
    /// would refuse the selector at once (measured: NVDAc and cbZEC revert in
    /// about 3,000 gas). No listed asset comes near the cap.
    ///
    /// A CALLER CANNOT STARVE IT INTO SAYING NO. With too little gas left the
    /// call is handed 63/64 of it and may run out and read as "not listed" -
    /// but then the trade is left with less than 1/64 of the cap, under 1,600
    /// gas, and everything after this check (the wrap or the pull, the swap,
    /// the curve) costs far more, so the trade runs out of gas and reverts.
    function _notBlacklisted(address asset, address account) private view {
        bytes4 selector = IBlacklistLookup.isBlacklisted.selector;
        bool listed;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, and(account, 0xffffffffffffffffffffffffffffffffffffffff))
            let ok := staticcall(PROBE_GAS, asset, 0x00, 0x24, 0x00, 0x20)
            listed := and(and(ok, gt(returndatasize(), 0x1f)), eq(mload(0x00), 1))
        }
        if (listed) revert BlacklistedBy(asset, account);
    }

    /// ALL OF IT OR NONE OF IT, ON EVERY HOP AFTER THE FIRST.
    ///
    /// SwapRouter02 pays each earlier hop's output to ITSELF and hands the
    /// next pool exactly that amount. A later pool that runs out of range
    /// takes part of it and returns, the rest stays on SwapRouter02 - where
    /// anybody can take it with sweepToken - and SwapRouter02 does not object.
    /// QuoterV2 prices that partial fill as if it were whole, so a bound the
    /// page derives from it does not catch this either. What this router
    /// measures for itself covers only the first hop; this covers the rest.
    ///
    /// So what SwapRouter02 holds of each asset the path passes THROUGH is
    /// read before the swap, and after it none of them may have grown. Where
    /// that asset is WETH its ether counts too, because SwapRouter02 pays a
    /// WETH leg with ether it already holds when it has enough, which turns
    /// ether into the WETH it received without either being left over.
    function _heldMidway(bytes calldata path) private view returns (uint256[] memory held) {
        held = new uint256[]((path.length - ADDR) / HOP - 1);
        for (uint256 i; i < held.length; i++) {
            held[i] = _swapRouterHolds(_midway(path, i));
        }
    }

    function _checkMidway(bytes calldata path, uint256[] memory held) private view {
        for (uint256 i; i < held.length; i++) {
            address asset = _midway(path, i);
            uint256 holds = _swapRouterHolds(asset);
            if (holds > held[i]) revert RouteStoppedMidway(asset, holds - held[i]);
        }
    }

    /// The i-th asset the path passes through: the token after hop i + 1.
    function _midway(bytes calldata path, uint256 i) private pure returns (address) {
        uint256 at = (i + 1) * HOP;
        return address(bytes20(path[at:at + ADDR]));
    }

    function _swapRouterHolds(address asset) private view returns (uint256 amount) {
        amount = IERC20(asset).balanceOf(SWAP_ROUTER);
        if (asset == WETH) amount += SWAP_ROUTER.balance;
    }

    function _clearAllowance(address asset, address spender) private {
        if (IERC20(asset).allowance(address(this), spender) != 0) IERC20(asset).forceApprove(spender, 0);
    }

    /// @dev WETH LEAVES AS ETHER, with all the gas there is - so a recipient
    ///      whose wallet is a contract with real work in its receive() is paid
    ///      like everybody else. The guard is still held, so that work cannot
    ///      come back in here. If the recipient will not take ether at all, the
    ///      ether is wrapped straight back and the WETH is sent instead: a sale
    ///      is never lost because of how its recipient takes delivery.
    function _payEth(address to, uint256 amount) private returns (bool asWeth) {
        IWrappedEther(WETH).withdraw(amount);
        (bool sent,) = to.call{value: amount}("");
        if (sent) return false;
        IWrappedEther(WETH).deposit{value: amount}();
        IERC20(WETH).safeTransfer(to, amount);
        return true;
    }
}
