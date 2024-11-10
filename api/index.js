const express = require('express');
const fetch = require('node-fetch');
const { Web3 } = require('web3');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// Configurations
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_CHAT_ID = process.env.CHANNEL_CHAT_ID;
const RPC_URL = process.env.RPC_URL; // Base Chain RPC URL
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const TARGET_ADDRESS = process.env.TARGET_ADDRESS;
const BUY_AMOUNT_ETH = ethers.utils.parseEther("0.005"); // Set to 0.005 ETH
const PNL_TARGET = 2.0; // Set to 2.0 for a 100% profit target (change to your preferred multiplier)
const SLIPPAGE_TOLERANCE = 0.06; // 1% slippage tolerance
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const web3 = new Web3(new Web3.providers.HttpProvider(RPC_URL));
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Uniswap Router Contract (example for Uniswap V2 on Base Chain)
const BASE_ROUTER_ADDRESS = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";  // Replace with actual Base Chain router address
const uniswapRouterABI = [
    // Add the Uniswap router ABI here (e.g., swapExactETHForTokens, swapExactTokensForETH, getAmountsOut)
];
const uniswapRouter = new ethers.Contract(BASE_ROUTER_ADDRESS, uniswapRouterABI, wallet);

// Helper function to send a message to Telegram
async function sendTelegramMessage(message) {
    try {
        await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CHANNEL_CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            })
        });
    } catch (error) {
        console.error('Failed to send message:', error);
    }
}

// Auto-buy function with slippage tolerance
async function autoBuyToken(tokenAddress) {
    try {
        const path = [web3.utils.toChecksumAddress(WALLET_ADDRESS), tokenAddress];
        const deadline = Math.floor(Date.now() / 1000) + 60 * 2; // 2 minutes from now

        // Estimate output amount
        const amountsOut = await uniswapRouter.getAmountsOut(BUY_AMOUNT_ETH, path);
        const minAmountOut = amountsOut[1].mul(1 - SLIPPAGE_TOLERANCE); // Set minimum amount based on slippage

        const tx = await uniswapRouter.swapExactETHForTokens(
            minAmountOut, // Minimum amount out based on slippage tolerance
            path,
            WALLET_ADDRESS,
            deadline,
            {
                value: BUY_AMOUNT_ETH,
                gasLimit: ethers.utils.hexlify(200000),
                gasPrice: ethers.utils.parseUnits('5', 'gwei')
            }
        );

        await tx.wait();
        sendTelegramMessage(`Auto-buy order executed: https://basescan.org/tx/${tx.hash}`);
        return tx;
    } catch (error) {
        console.error('Auto-buy failed:', error);
        return null;
    }
}

// Monitor PnL and auto-sell based on customizable PnL target
async function monitorAndAutoSell(tokenAddress, buyAmountEth) {
    const tokenContract = new ethers.Contract(tokenAddress, [
        // Add ERC20 ABI functions (balanceOf, decimals, etc.)
    ], wallet);

    while (true) {
        try {
            const balance = await tokenContract.balanceOf(WALLET_ADDRESS);
            const decimals = await tokenContract.decimals();
            const balanceInEth = balance / Math.pow(10, decimals);
            const tokenPriceInEth = await getTokenPriceInEth(tokenAddress); // Custom function needed to fetch price
            const currentValue = balanceInEth * tokenPriceInEth;
            const pnl = currentValue / parseFloat(ethers.utils.formatEther(buyAmountEth));

            if (pnl >= PNL_TARGET) {
                sendTelegramMessage("PnL target reached. Executing auto-sell.");
                await autoSellToken(tokenAddress, balance);
                break; // Exit monitoring after selling
            }

            await new Promise(resolve => setTimeout(resolve, 30000)); // Check every 30 seconds
        } catch (error) {
            console.error("Error in monitoring PnL:", error);
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
}

// Auto-sell function with slippage tolerance
async function autoSellToken(tokenAddress, amount) {
    try {
        const path = [tokenAddress, web3.utils.toChecksumAddress(WALLET_ADDRESS)];
        const deadline = Math.floor(Date.now() / 1000) + 60 * 2; // 2 minutes from now

        // Estimate output amount
        const amountsOut = await uniswapRouter.getAmountsOut(amount, path);
        const minAmountOut = amountsOut[1].mul(1 - SLIPPAGE_TOLERANCE); // Set minimum amount based on slippage

        const tx = await uniswapRouter.swapExactTokensForETH(
            amount,
            minAmountOut, // Minimum amount out based on slippage tolerance
            path,
            WALLET_ADDRESS,
            deadline,
            {
                gasLimit: ethers.utils.hexlify(200000),
                gasPrice: ethers.utils.parseUnits('5', 'gwei')
            }
        );

        await tx.wait();
        sendTelegramMessage(`Auto-sell order executed: https://basescan.org/tx/${tx.hash}`);
    } catch (error) {
        console.error("Auto-sell failed:", error);
    }
}

// Monitor for new token deployments and initiate auto-buy
async function monitorForDeployments() {
    let latestBlock = await web3.eth.getBlockNumber();

    setInterval(async () => {
        const newBlock = await web3.eth.getBlockNumber();
        if (newBlock > latestBlock) {
            const block = await web3.eth.getBlock(newBlock, true);
            for (let tx of block.transactions) {
                if (tx.from.toLowerCase() === TARGET_ADDRESS.toLowerCase() && tx.to === null) {
                    const tokenAddress = tx.contractAddress;
                    const buyTx = await autoBuyToken(tokenAddress);
                    if (buyTx) await monitorAndAutoSell(tokenAddress, BUY_AMOUNT_ETH);
                }
            }
            latestBlock = newBlock;
        }
    }, 10000); // Check every 10 seconds
}

monitorForDeployments();

module.exports = app;
