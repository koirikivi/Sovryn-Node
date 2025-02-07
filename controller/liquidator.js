/**
 * Liquidation handler
 * If liquidation is successful removes position from liquidation list
 * If it fails, check if the liquidation criteria are still met.
 * If no, delete it from the liquidation list. If yes, send an error notification to a telegram group for manual processing.
 *
 * todo: If the contract returns WRBTC when liquidating long positions -> swap the WRBTC For RBTC to avoid bankrupcy of the wallet
 * alternative: liquidate only with wrbtc
 */

import C from './contract';
import U from '../util/helper';
import A from '../secrets/accounts';
import Wallet from './wallet';
import Arbitrage from '../controller/arbitrage';
import conf from '../config/config';
import tokensDictionary from '../config/tokensDictionary.json'
import common from './common'
import abiDecoder from 'abi-decoder';
import abiComplete from "../config/abiComplete";
import dbCtrl from './db';

class Liquidator {
    constructor() {
        this.liquidationErrorList=[];
        abiDecoder.addABI(abiComplete);
    }

    start(liquidations) {
        this.liquidations = liquidations;
        this.checkPositionsForLiquidations();
    }

    /**
     * Wrapper for liquidations
     * 1. Get a wallet with enough funds in required tokens and which is not busy at the moment, then
     * 2. Try to liquidate position
     */
    async checkPositionsForLiquidations() {
        while (true) {
            console.log("started liquidation round");
            console.log(Object.keys(this.liquidations).length + " positions need to be liquidated");

            for (let p in this.liquidations) {
                const pos = this.liquidations[p];
                const token = pos.loanToken.toLowerCase() === conf.testTokenRBTC ? "rBtc" : pos.loanToken;

                //Position already in liquidation wallet-queue
                if (Wallet.checkIfPositionExists(p)) continue;
                //failed too often -> have to check manually
                if(this.liquidationErrorList[p]>=5) continue;

                const [wallet, wBalance] = await Wallet.getWallet("liquidator", pos.maxLiquidatable, token);
                if (!wallet) {
                    await this.handleNoWalletError(p);
                    continue;
                } 
                const liquidateAmount = pos.maxLiquidatable<wBalance?pos.maxLiquidatable:wBalance;
                if(pos.maxLiquidatable<wBalance) console.log("enough balance on wallet");
                else if (wBalance === 0) { console.log("not enough balance on wallet"); return; }
                else console.log("not enough balance on wallet. only use "+wBalance);

                const nonce = await C.web3.eth.getTransactionCount(wallet.adr, 'pending');

                await this.liquidate(p, wallet.adr, liquidateAmount, token, nonce);
                await U.wasteTime(1); //1 second break to avoid rejection from node
            }
            console.log("Completed liquidation round");
            await U.wasteTime(conf.liquidatorScanInterval);
        }
    }

    /**
    * swaps back to collateral currency after liquidation is completed
    * @param value should be sent in Wei format as String
    * @param sourceCurrency should be that hash of the contract
    * @param destCurrency is defaulting for now to 'rbtc'. It is also the hash of the contract
    */
    async swapBackAfterLiquidation(value, sourceCurrency, destCurrency = 'rbtc') {
        sourceCurrency = sourceCurrency === 'rbtc' ? sourceCurrency : tokensDictionary[conf.network][sourceCurrency];
        destCurrency = destCurrency === 'rbtc' ? destCurrency : tokensDictionary[conf.network][destCurrency];
        console.log(`Swapping back ${value} ${sourceCurrency} to ${destCurrency}`);
        try {
            const prices = await Arbitrage.getRBtcPrices();
            const tokenPriceInRBtc = prices[sourceCurrency];
            if (!tokenPriceInRBtc) throw "No prices found for the " + sourceCurrency + " token";
            const res = await Arbitrage.swap(value, sourceCurrency, destCurrency, A.liquidator[0].adr);
            if (res) console.log("Swap successful!");
        } catch(err) {
            console.log("Swap failed", err);
        }
    }

    /*
    * Tries to liquidate a position
    * If Loan token == WRBTC -> pass value
    * wallet = sender and receiver address
    */
    async liquidate(loanId, wallet, amount, token, nonce) {
        console.log("trying to liquidate loan " + loanId + " from wallet " + wallet + ", amount: " + amount);
        Wallet.addToQueue("liquidator", wallet, loanId);
        const val = (token === "rBtc") ? amount : 0;
        console.log("Sending val: " + val);
        console.log("Nonce: " + nonce);

        if (this.liquidations && this.liquidations.length > 0) {
            //delete position from liquidation queue, regardless of success or failure because in the latter case it gets added again anyway
            delete this.liquidations[loanId];
        }

        const p = this;
        const gasPrice = await C.getGasPrice();
        C.contractSovryn.methods.liquidate(loanId, wallet, amount.toString())
            .send({ from: wallet, gas: 2500000, gasPrice: gasPrice, nonce: nonce, value: val })
            .then(async (tx) => {
                console.log("loan " + loanId + " liquidated!");
                console.log(tx.transactionHash);
                await p.handleLiqSuccess(wallet, loanId, tx.transactionHash);
                p.addLiqLog(tx.transactionHash);
                await p.swapBackAfterLiquidation(val, token);
            })
            .catch(async (err) => {
                console.error("Error on liquidating loan " + loanId);
                console.error(err);
                await p.handleLiqError(wallet, loanId);
            });
    }

    async handleLiqSuccess(wallet, loanId, txHash) {
        Wallet.removeFromQueue("liquidator", wallet, loanId);
        this.liquidationErrorList[loanId]=null;
        const msg = conf.network + "net-liquidation of loan " + loanId + " successful. \n " + txHash;
        await common.telegramBot.sendMessage(msg);
    }

    /**
     * Possible errors:
     * 1. Another user was faster -> position is already liquidated
     * 2. Btc price moved in opposite direction and the amount cannot be liquidated anymore
     */
    async handleLiqError(wallet, loanId) {
        Wallet.removeFromQueue("liquidator", wallet, loanId);
        if(!this.liquidationErrorList[loanId]) this.liquidationErrorList[loanId]=1;
        else this.liquidationErrorList[loanId]++;

        const updatedLoan = await C.getPositionStatus(loanId)
        if (updatedLoan.maxLiquidatable > 0) {
            console.log("loan " + loanId + " should still be liquidated. Please check manually");
            await common.telegramBot.sendMessage(conf.network + "net-liquidation of loan " + loanId + " failed.");
        }
    }

    async handleNoWalletError(loanId) {
        console.error("Liquidation of loan " + loanId + " failed because no wallet with enough funds was available");
        await common.telegramBot.sendMessage(conf.network + "net-liquidation of loan " + loanId + " failed because no wallet with enough funds was found.");
    }

    async calculateLiqProfit(liqEvent) {
        console.log("Calculate profit for liquidation", liqEvent.loanId);
        // To calculate the profit from a liquidation we need to get the difference between the amount we deposit in the contract, repayAmount,
        // and the amount we get back, collateralWithdrawAmount. But to do this we need to convert both to the same currency
        // Convert spent amount to collateral token 
        const convertedPaidAmount = await Arbitrage.getPriceFromPriceFeed(C.contractPriceFeed, liqEvent.loanToken, liqEvent.collateralToken, liqEvent.repayAmount);
        if (convertedPaidAmount) {
            const liqProfit = C.web3.utils.toBN(liqEvent.collateralWithdrawAmount).sub(C.web3.utils.toBN(convertedPaidAmount));
            console.log("You made "+liqProfit+" "+tokensDictionary[conf.network][liqEvent.collateralToken]+" with this liquidation");
            return liqProfit;
        }
        else {
            console.log("Couldn't calculate the profit for the given liquidation");
        }
    }

    async addLiqLog(txHash) {
        console.log("Add liquidation "+txHash+" to db");
        try {
            const receipt = await C.web3.eth.getTransactionReceipt(txHash);
            
            if (receipt && receipt.logs) {
                const logs = abiDecoder.decodeLogs(receipt.logs) || [];
                const liqEvent = logs.find(log => log && log.name === 'Liquidate');
                console.log(liqEvent)
                const {
                    user, liquidator, loanId, loanToken, collateralToken, collateralWithdrawAmount
                } = U.parseEventParams(liqEvent && liqEvent.events);

                console.log(user);
                console.log(liquidator);
                console.log(loanId)
                console.log('\n LIQEVENT', U.parseEventParams(liqEvent && liqEvent.events))

                if (user && liquidator && loanId) {
                    console.log("user found");
                    console.log(user);
                    console.log(liquidator);
                    console.log(loanId);
                    const path = await C.contractSwaps.methods['conversionPath'](collateralToken, loanToken).call();
                    const numberOfHops = loanToken === "rbtc" ? 3 : 5

                    if (!path || path.length !== numberOfHops) return;

                    const balBefore = await C.getWalletTokenBalance(liquidator, loanToken);
                    const affiliateAcc = "0x0000000000000000000000000000000000000000";
                    const gasPrice = await C.getGasPrice();
                    const approved = await C.approveToken(C.getTokenInstance(collateralToken), liquidator, conf.swapsImpl, collateralWithdrawAmount);
                    const swapTx = await C.contractSwaps.methods['convertByPath'](path, collateralWithdrawAmount, 1, liquidator, affiliateAcc, 0).send({
                        from: liquidator,
                        gas: 2500000,
                        gasPrice: gasPrice
                    });

                    const balAfter = await C.getWalletTokenBalance(liquidator, loanToken);
                    const profit = parseFloat(balAfter) - parseFloat(balBefore);
                    //wrong -> update
                    const pos = loanToken.toLowerCase() === conf.testTokenRBTC ? 'long' : 'short';
                    const liqProfit = await this.calculateLiqProfit(U.parseEventParams(liqEvent && liqEvent.events));

                    const addedLog = await dbCtrl.addLiquidate({
                        liquidatorAdr: liquidator,
                        liquidatedAdr: user,
                        amount: collateralWithdrawAmount,
                        pos: pos,
                        loanId: loanId,
                        profit: profit,
                        txHash: txHash,
                        profit: liqProfit
                    });

                    return addedLog;
                }
            }

        } catch (e) {
            console.error(e);
        }
    }
}

export default new Liquidator();
