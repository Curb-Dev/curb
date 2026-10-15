// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPonsV2FeeEscrow} from "../vendor/interfaces/ILaunchpadV2.sol";
import {IWETH} from "./IWETH.sol";

/**
 * @title FeeEscrow
 * @notice Where a curve's fees wait until the person they belong to takes them.
 *
 * WHAT IT REPLACES, AND WHY THAT MATTERED
 *   The stack shipped with a MOCK escrow: it accepted the tokens and its
 *   claim functions returned zero with no way to move anything out. Every fee
 *   a curve ever swept would have been locked in it forever. That was fine for
 *   a fork demo and is the single reason this contract exists.
 *
 * WHO CAN TAKE WHAT
 *   Balances are kept per RECIPIENT and per TOKEN, and a claim pays the CALLER
 *   from the CALLER'S OWN balance to the CALLER'S OWN address. There is no
 *   claim-on-behalf, no administrator, no owner, no pause, no way to move one
 *   person's balance to another and no address anywhere in this contract that
 *   is privileged over another. The creator takes the creator's share and we
 *   take ours because those are the only two things the code can do.
 *
 *   Nothing here decides WHO those two are. The curve names them when it
 *   sweeps, out of terms frozen when the launch was created.
 *
 * WHAT IT DOES NOT PROTECT AGAINST, STATED PLAINLY
 *   An escrow moves one problem, it does not remove it. A curve's sweep pays
 *   ONE address instead of two, so a creator whose address cannot receive
 *   NVDAc no longer stops that sweep - and, since graduation sweeps on its way
 *   through, no longer stops a launch graduating. Their balance simply waits.
 *
 *   IT DOES NOTHING IF NVDAc ITSELF STOPS MOVING. If the issuer restricts
 *   transfers to or from THIS contract, the fees are stuck here rather than
 *   stuck in transit, and that is not an improvement. B20 tokens can be
 *   restricted; this contract has no answer to it and no back door that would
 *   pretend to.
 *
 *   AND A LOST KEY IS PERMANENT. A credit here is keyed to the address that
 *   earned it, and there is no administrator here who could reassign a
 *   balance - deliberately, because an address that CAN move somebody else's
 *   fees is a far larger risk than a balance nobody claims. The cost is real
 *   and is the cost of not having that address exist. (A launch's beneficiary
 *   never changes; under core v2 its FUTURE income can be switched once, one
 *   way, to the launch's own holder distributor - PRE_MAINNET C3 - which then
 *   claims its own credits here. Nobody can name that address, and the switch
 *   moves no credit already in this escrow.)
 *
 * ONE TOKEN, ON PURPOSE
 *   This version holds exactly the quote asset it was deployed for. A token it
 *   does not know is refused rather than accepted into a balance nobody would
 *   think to claim, and native ETH is refused outright - the interface carries
 *   a native ledger this product has no use for, and a silent no-op there
 *   would be a place for value to disappear.
 */
contract FeeEscrow is IPonsV2FeeEscrow {
    using SafeERC20 for IERC20;

    /// The only asset this escrow holds. Immutable: an escrow that could be
    /// pointed at another token could be pointed away from the balances it
    /// already owes.
    address public immutable quoteToken;

    /// @notice Base's wrapped ether, an OP-Stack predeploy at the same address
    ///         on every Base network.
    /// @dev A CONSTANT RATHER THAN A CONSTRUCTOR ARGUMENT, so no existing
    ///      deployment's signature changes. An escrow whose quote asset is
    ///      anything else never reaches the code that reads this.
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    mapping(address recipient => mapping(address token => uint256 amount)) private _credited;

    /// A plain flag rather than a library, because the whole of it is here to
    /// be read: a claim writes the balance down BEFORE it transfers, so a
    /// token that calls back finds nothing left to claim. The guard is the
    /// second line, not the first.
    bool private _entered;

    event Credited(address indexed recipient, address indexed token, uint256 amount);
    event Claimed(address indexed recipient, address indexed token, uint256 amount);
    /// The claim above left as ETH.
    event ClaimedAsNative(address indexed recipient, uint256 amount);
    /// The claim above was OFFERED as ETH, refused, and paid in WETH.
    ///
    /// SAID OUT LOUD RATHER THAN INFERRED FROM THE OTHER ONE'S ABSENCE. An
    /// escrow that never tries the ether path at all also emits neither, and
    /// the test for this fallback could not tell those apart until this
    /// event existed - it passed with the unwrapping deleted.
    event ClaimedAsWrapped(address indexed recipient, uint256 amount);

    error NativeNotSupported();
    error UnsupportedToken(address token);
    error ZeroRecipient();
    error ZeroAmount();
    error DeliveryMismatch(address token, uint256 expected, uint256 delivered);
    error NothingToClaim(address recipient, address token);
    error ClaimExceedsBalance(uint256 requested, uint256 available);
    error ShortPayment(address token, uint256 owed, uint256 paid);
    error OverDrawn(address token, uint256 allowed, uint256 taken);
    error RecipientIsTheEscrow();
    error Reentrancy();
    /// ETH arrived from something other than unwrapping this escrow's own
    /// WETH. There is no balance to credit it to, so it is refused.
    error UnexpectedNative(address from);

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address quoteToken_) {
        if (quoteToken_ == address(0)) revert UnsupportedToken(quoteToken_);
        quoteToken = quoteToken_;
    }

    /// @notice Accepts ETH from WETH alone.
    /// @dev THE ONLY ETH THIS CONTRACT SHOULD EVER SEE is what it just
    ///      unwrapped for a claim in progress. Anything else would be money
    ///      with no credited balance behind it and no way out, so it is
    ///      refused rather than trapped. credit() still refuses ETH sent
    ///      deliberately; this refuses ETH sent by accident.
    receive() external payable {
        if (msg.sender != WETH) revert UnexpectedNative(msg.sender);
    }

    // ------------------------------------------------------------------
    // paying in
    // ------------------------------------------------------------------

    /// @notice Pulls `amount` from the caller and credits it to `recipient`.
    /// @dev THE CREDIT IS WHAT ARRIVED, not what was asked for. The balance is
    ///      measured on both sides of the transfer and anything other than an
    ///      exact delivery is refused: a short one would credit somebody for
    ///      money this contract does not hold, and a long one would mean the
    ///      token is doing something this contract does not model. Refusing
    ///      both keeps every balance backed one for one.
    function creditToken(address recipient, address token, uint256 amount) external nonReentrant {
        if (token != quoteToken) revert UnsupportedToken(token);
        if (recipient == address(0)) revert ZeroRecipient();
        // A balance credited to this contract could never be claimed - the
        // escrow cannot call itself - and it would make the measurements in
        // _claim read one account twice. Refused rather than left as a corner.
        if (recipient == address(this)) revert RecipientIsTheEscrow();
        if (amount == 0) revert ZeroAmount();

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 delivered = IERC20(token).balanceOf(address(this)) - before;
        if (delivered != amount) revert DeliveryMismatch(token, amount, delivered);

        _credited[recipient][token] += delivered;
        emit Credited(recipient, token, delivered);
    }

    /// @notice Refused. This product's quote asset is never native ETH.
    /// @dev payable because the interface says so; reverting returns the value.
    function credit(address) external payable {
        revert NativeNotSupported();
    }

    // ------------------------------------------------------------------
    // taking out
    // ------------------------------------------------------------------

    /// @notice Pays the caller their whole balance of `token`.
    function claimToken(address token) external returns (uint256) {
        return _claim(token, _credited[msg.sender][token]);
    }

    /// @notice Pays the caller `amount` of their balance of `token`.
    function claimToken(address token, uint256 amount) external returns (uint256) {
        return _claim(token, amount);
    }

    /// @dev THE BALANCE GOES DOWN FIRST. Writing it after the transfer would
    ///      leave a window in which a token that hands control back sees the
    ///      full balance still standing - the classic shape - and the
    ///      reentrancy guard would be the only thing between that and paying
    ///      twice. Here it is one of two things, and the ordering is the one
    ///      that does not depend on the guard being right.
    ///
    ///      A FAILED TRANSFER TAKES THE WRITE WITH IT. safeTransfer turns a
    ///      `false` return into a revert, so the whole call unwinds and the
    ///      balance is exactly what it was.
    ///
    ///      TWO MEASUREMENTS, BECAUSE ONE OF THEM PROTECTS THE WRONG PERSON.
    ///
    ///      THE CLAIMANT: the recipient's balance is measured across the
    ///      transfer and must rise by at least what they claimed. A token that
    ///      returns TRUE and pays less cannot be seen any other way - measured
    ///      before this existed, a 4e18 balance paid 3.96e18 and still went to
    ///      zero.
    ///
    ///      EVERYONE ELSE IN THE ESCROW: this contract's OWN balance is
    ///      measured too, and must fall by no more than what was claimed. The
    ///      recipient check alone does not cover this: a token that pays the
    ///      claimant their full 4 and takes 4.04 from the sender passes it,
    ///      and the extra 0.04 comes out of what backs OTHER people's
    ///      balances. This is a shared vault, so a claim has to be bounded on
    ///      both sides or one claimant can be made whole out of another's
    ///      money.
    ///
    ///      WHAT `paid` DOES AND DOES NOT ESTABLISH. It is the recipient's NET
    ///      gain, not a measurement of delivery, and the two differ: a
    ///      recipient that forwards the tokens onward from inside a transfer
    ///      callback ends up with less than was delivered to them. THIS CHECK
    ///      REFUSES THAT CLAIM TOO. It cannot tell the cases apart, so it pays
    ///      out under neither - the conservative reading.
    ///
    ///      THAT IS A REAL LIMIT, NOT A CHOICE EVERY CLAIMANT HAS. An account
    ///      whose forwarding is in immutable code cannot decide to stop doing
    ///      it, and for such an address this escrow is simply unusable: it
    ///      would have to claim to a different address, which for a launch's
    ///      creator is the address they can no longer change. What the test
    ///      establishes is that the claim is REFUSED - not that anyone can
    ///      arrange to satisfy it.
    ///
    ///      A surplus on the recipient's side is not refused: their balance can
    ///      rise for reasons that have nothing to do with this contract. The
    ///      escrow's own side is the one with a ceiling.
    function _claim(address token, uint256 amount) private nonReentrant returns (uint256) {
        if (token != quoteToken) revert UnsupportedToken(token);

        // Set only on the path where ether was offered and turned down, so
        // the event below distinguishes that from never having offered.
        bool refused;

        uint256 available = _credited[msg.sender][token];
        if (available == 0) revert NothingToClaim(msg.sender, token);
        if (amount == 0) revert ZeroAmount();
        if (amount > available) revert ClaimExceedsBalance(amount, available);

        _credited[msg.sender][token] = available - amount;

        // ---- WETH LEAVES AS ETH.
        //
        // WHY HERE AND NOT AT THE OTHER END: the credit is denominated in the
        // quote asset and stays that way, so every balance, every event and
        // every measurement below is unchanged. Only the last step differs.
        //
        // FULL GAS, DELIBERATELY. The recipient is the caller, the balance is
        // already written down, and nonReentrant is still held - so a claimant
        // whose wallet is a contract with real work in its receive() is paid
        // in ETH like everybody else rather than quietly dropped to WETH.
        //
        // AND IT MAY STILL FAIL, at which point the ether is wrapped straight
        // back and the ordinary token path below pays out. A claim is never
        // lost because of how the claimant takes delivery.
        if (token == WETH) {
            uint256 ethBefore = address(this).balance;
            IWETH(WETH).withdraw(amount);
            uint256 unwrapped = address(this).balance - ethBefore;
            if (unwrapped != amount) revert DeliveryMismatch(WETH, amount, unwrapped);

            (bool sent,) = msg.sender.call{value: amount}("");
            if (sent) {
                emit Claimed(msg.sender, token, amount);
                emit ClaimedAsNative(msg.sender, amount);
                return amount;
            }
            IWETH(WETH).deposit{value: amount}();
            refused = true;
        }

        // TO THE CALLER, NEVER TO A PARAMETER. There is no recipient argument
        // anywhere in this contract's claim path, so there is nothing for a
        // caller to point somewhere else and nothing for a phishing flow to
        // fill in.
        uint256 claimantBefore = IERC20(token).balanceOf(msg.sender);
        uint256 escrowBefore = IERC20(token).balanceOf(address(this));

        IERC20(token).safeTransfer(msg.sender, amount);

        uint256 paid = IERC20(token).balanceOf(msg.sender) - claimantBefore;
        if (paid < amount) revert ShortPayment(token, amount, paid);

        uint256 taken = escrowBefore - IERC20(token).balanceOf(address(this));
        if (taken > amount) revert OverDrawn(token, amount, taken);

        emit Claimed(msg.sender, token, amount);
        if (refused) emit ClaimedAsWrapped(msg.sender, amount);
        return amount;
    }

    /// @notice Refused. See credit().
    function claim() external pure returns (uint256) {
        revert NativeNotSupported();
    }

    /// @notice Refused. See credit().
    function claim(uint256) external pure returns (uint256) {
        revert NativeNotSupported();
    }

    // ------------------------------------------------------------------
    // reading
    // ------------------------------------------------------------------

    function balanceOfToken(address recipient, address token) external view returns (uint256) {
        return _credited[recipient][token];
    }

    /// @notice Always zero: native ETH cannot be credited here at all.
    /// @dev A view that reverted would break readers for no gain; zero is the
    ///      honest answer, because no path in this contract can make it
    ///      anything else.
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}
