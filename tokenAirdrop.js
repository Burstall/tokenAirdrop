import {
	PrivateKey,
	Client,
	TransferTransaction,
	Hbar,
	HbarUnit,
} from '@hashgraph/sdk';
import 'dotenv/config';
import * as fs from 'fs';

import fetch from 'cross-fetch';
import { exit } from 'process';

const maxRetries = 10;
let verbose = false;
const memo = process.env.MEMO || 'Airdrop';
const env = process.env.ENVIRONMENT ?? null;
const dbHeaders = '#destWallet,tokenToSend,quantity,serial\n';
const baseUrlForMainnet = 'https://mainnet-public.mirrornode.hedera.com';
const baseUrlForTestnet = 'http://testnet.mirrornode.hedera.com';

/*
Read in the flat file Database
check lines with regex mask to start with wallet else ignore line
format:
#destWallet,tokenToSend,quantity,serial

serial=0 implies send a random NFT owned (excluding any serials in the .env file EXCLUDE_SERIALS variable [a comma seperated list or a range **NEVER BOTH**])

for example
0.0.XXXX,0.0.YYYYY,1,0  -> send any random NFT owned
0.0.XXXX,0.0.YYYYY,1,3  -> send user serial 3 (if owned else error message / skip)
0.0.XXXX,0.0.ZZZZZ,1	-> send user 1 FC token
*/
async function readDB(fileToProcess, maxTferAmt, excludeWalletsList) {
	const tokenTransfers = [];
	const skippedTfrs = [];

	const userAmtMap = new Map();
	const tokenBalancesMaps = new Map();

	let lineNum = 0;

	try {
		try {
			fs.access(fileToProcess, fs.constants.F_OK, (err) => {
				if (err) {
					console.log(`${fileToProcess} does not exist - Creating the file`, err);
					fs.writeFileSync(fileToProcess, dbHeaders);

					// Test the if the file exists again
					fs.access(fileToProcess, fs.constants.F_OK, (err) => {
						if (err) {
						// failed to create hard abort
							console.log('ERROR: could not read or create the file', err);
							exit(1);
						}
					});
				}
			});
		}
		catch (err) {
			console.log(`${fileToProcess} does not exist - Creating the file`, err);
			fs.writeFileSync(fileToProcess, dbHeaders);

			// Test the if the file exists again
			fs.access(fileToProcess, fs.constants.F_OK, (err) => {
				if (err) {
					// failed to create hard abort
					console.log('ERROR: could not read or create the file', err);
					exit(1);
				}
			});
		}


		const allFileContents = fs.readFileSync(fileToProcess, 'utf-8');
		const lines = allFileContents.split(/\r?\n/);
		for (let l = 0; l < lines.length; l++) {
			const line = lines[l];
			// discard if headers [i.e. does not start with 0. for wallet ID]
			// also remove attempts ot pay yourself
			lineNum++;
			if (!/^0.0.[1-9][0-9]+,/i.test(line)) {
				console.log(`DB: Skipping line ${lineNum} - poorly formed wallet address: ${line}`);
				continue;
			}
			const [receiverWallet, tokenId, qty, ...rest] = line.split(',');
			const quantity = Number(qty);
			const serialArray = rest.length == 0 ? [0] : rest;

			let tokenBalMap;
			let walletAssociated;
			if (tokenId.toLowerCase() != 'hbar') {
				tokenBalMap = tokenBalancesMaps.get(tokenId) || null;
				if (tokenBalMap == null) {
					if (verbose) console.log('Building token/balance map for', tokenId);
					tokenBalMap = await getTokenBalanceMap(tokenId);
					tokenBalancesMaps.set(tokenId, tokenBalMap);
				}

				walletAssociated = tokenBalMap.get(receiverWallet) >= 0 ? true : false;
			}
			else {
				walletAssociated = true;
			}

			let amt = userAmtMap.get(receiverWallet) || 0;
			if (excludeWalletsList.includes(receiverWallet)) {
				console.log(`wallet (${receiverWallet} had ${quantity} in file, **SKIPPING** as wallet in exclude list`);
				const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, 'EXCLUDED WALLET: **SKIPPED**', false);
				skippedTfrs.push(tx);
			}
			else if (!walletAssociated) {
				console.log(`wallet (${receiverWallet} had ${quantity} in file, **SKIPPING** as wallet has not associated the token`);
				const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, 'NOT ASSOCIATED: **SKIPPED**', false);
				skippedTfrs.push(tx);
			}
			else if (quantity == 0) {
				console.log(`wallet (${receiverWallet} had ${quantity} in file, **SKIPPING** as no tokens instructed to be sent`);
				const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, 'ZERO Quantity **SKIPPED**', false);
				skippedTfrs.push(tx);
			}
			else if (maxTferAmt != null && ((amt + quantity) > maxTferAmt)) {
				const remCapacity = maxTferAmt - amt;
				if (remCapacity > 0) {
					console.log(`wallet (${receiverWallet} had ${quantity} in file, sending ${remCapacity} instead due to MAX_TRANSFER (${maxTferAmt}) limit`);
					amt += remCapacity;
					const tx = new Transaction(receiverWallet, tokenId, remCapacity, serialArray, `MAX TRANSFER LIMIT: Quantity reduced by ${quantity - remCapacity}`, false);
					tokenTransfers.push(tx);
				}
				else {
					console.log(`wallet (${receiverWallet} had ${quantity} in file, **SKIPPING** instead due to MAX_TRANSFER (${maxTferAmt}) limit`);
					const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, 'MAX TRANSFER LIMIT: **SKIPPED**', false);
					skippedTfrs.push(tx);
				}
			}
			else {
				const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, '', false);
				tokenTransfers.push(tx);
				amt += quantity;
			}
			userAmtMap.set(receiverWallet, amt);
		}
		return [tokenTransfers, skippedTfrs, tokenBalancesMaps];
	}
	catch (err) {
		console.log('ERROR: Could not read DB - error on line:', lineNum, err);
		// hard abort to avoid duplicate results
		exit(1);
	}
}

function writeDB(tokenTransfers, skippedTxs, filename) {
	const updateTime = new Date();
	let outputStr = `##LAST UPDATE = ${updateTime.toISOString()}\n${dbHeaders}`;
	try {
		for (let t = 0 ; t < tokenTransfers.length; t++) {
			const tfr = tokenTransfers[t];
			if (tfr instanceof Transaction) {
				if (tfr.success) {
					outputStr += `##SUCESS##${tfr.toString()}\n`;
				}
				else {
					outputStr += `**FAILED**${tfr.toString()}\n`;
				}
			}
		}
		// add skipped lines
		for (let s = 0; s < skippedTxs.length; s++) {
			const tfr = skippedTxs[s];
			if (tfr instanceof Transaction) {
				outputStr += `!!SKIPPED!!${tfr.toString()}\n`;
			}
		}
		fs.writeFile('output' + filename, outputStr, () => {
			console.log('Transfers logged to DB file');
		});
	}
	catch (err) {
		console.log('Error writign the DB file:', err);
	}
}

// create an object to simplify rather thn passing arrays around
class Transaction {
	constructor(recieverWallet, tokenId, quantity, serialArray, msg, success) {
		this.receiverWallet = recieverWallet;
		this.tokenId = tokenId;
		this.quantity = quantity;
		this.serialArray = [];
		const sA = serialArray.slice(0, quantity);
		// cast to ensure Numbers
		for (let s = 0; s < sA.length; s++) {
			this.serialArray.push(Number(sA[s]));
		}

		// ensure serial array is as long as the qty
		while (this.serialArray.length < this.quantity) {
			this.serialArray.push(0);
		}
		this.message = msg;
		this.success = success;
	}

	getSerialString() {
		let serialString = '';
		for (let s = 0; s < this.serialArray.length; s++) {
			if (s > 0) {
				serialString += ',' + this.serialArray[s];
			}
			else {
				serialString += this.serialArray[s];
			}
		}
		return serialString;
	}

	toString() {
		return `${this.receiverWallet},${this.tokenId},${this.quantity},${this.serialArray},${this.message}`;
	}

	setSerials(newSerialArray) {
		this.serialArray = newSerialArray;
	}
}

async function processTransfers(tfrArray, tokenBalancesMaps, excludeSerialsList, test) {

	if (tfrArray.length == 0) {
		console.log('No transfers sent for processing - BUGGING OUT');
		exit(1);
	}
	// need to know the sender for pre-flight checks
	const senderAccountId = process.env.MY_ACCOUNT_ID;
	console.log('[INFO]: Using sender:', senderAccountId);

	// iterate over transfers proposed
	const tokenTypeMap = new Map();
	const tokenQtyMap = new Map();
	const tokenDecimalsMap = new Map();
	const tokenArray = [];

	// split the transfer types -- recombine to return them.
	const nftTokenTfr = [];
	const fungibleTokenTfr = [];
	const hbarTfr = [];

	// create array for skipped in pre-flight check
	const skippedTfr = [];

	// Pre-flight checks
	// check the sender has enough in the account of each token [tokenBalMaps]
	// check the serials if it is an NFT are owned
	// check none of the serials are on the exclude list
	// print each potential tx to console
	// if test mode then exit.
	// tokenID vs quantity
	const ownedTokenMap = new Map();
	// token vs array of serials owned
	const serialsOwnedMap = new Map();
	// keep a list of error token addresses to exclude those txs
	const errorTokenIds = [];

	// figure out total to send per token ID and the token type.
	for (let t = 0; t < tfrArray.length; t++) {
		const tfr = tfrArray[t];
		if (tfr instanceof Transaction) {
			const tokenId = tfr.tokenId.toLowerCase();
			let tokenType = tokenTypeMap.get(tokenId) || null;
			let decimals = 0;


			// if tokenType is null then we have not processed this token yet so build the details
			if (tokenType == null) {
				if (tokenId == 'hbar') {
					tokenType = 'HBAR';
					tokenTypeMap.set(tokenId, tokenType);
					const hbarBal = await getHbarBalance(senderAccountId);
					ownedTokenMap.set(tokenId, hbarBal);
					tokenArray.push(tokenId);
				}
				else {
					[tokenType, decimals] = await getTokenType(tokenId);
					tokenTypeMap.set(tokenId, tokenType);
					tokenDecimalsMap.set(tokenId, decimals);
					tokenArray.push(tokenId);

					const tknBalMap = tokenBalancesMaps.get(tokenId);
					const bal = tknBalMap.get(senderAccountId) || 0;
					ownedTokenMap.set(tokenId, bal);

					// fetch the serial list if an NFT
					if (tokenType == 'NON_FUNGIBLE_UNIQUE') {
						// time to get serials owned
						const serialsOwned = await getSerialsOwned(tokenId, senderAccountId, excludeSerialsList);
						serialsOwnedMap.set(tokenId, serialsOwned);
					}
					else if (tokenType == 'FUNGIBLE_COMMON') {
						// adjust for the decimals
						const balDecimalAdjusted = bal * (10 ** -decimals);
						ownedTokenMap.set(tokenId, balDecimalAdjusted);
					}
					else {
						// catch-all suggests we have an error
						console.log('[ERROR]: please check the token specified -- looks like it is not a token (maybe a wallet):', tokenId);
						errorTokenIds.push(tokenId);
					}
				}
			}

			// split tx into FC / NFT given different sending logic
			// check no serials requested on exclude list
			// check account owns a given serial
			if (tokenType == 'NON_FUNGIBLE_UNIQUE') {
				// check that the serials requested are not on exclude list
				// else it becomes a skipped tx
				// N.B. can be a comma seperated list
				const serialArray = tfr.serialArray;
				const anyExcludedSerials = serialArray.some(s => excludeSerialsList.includes(s));
				if (anyExcludedSerials) {
					// error Tx
					tfr.message = 'ERROR: requested to send an NFT on the **EXCLUDE** list';
					skippedTfr.push(tfr);
					continue;
				}
				// now check the sender owns that serial if specified
				let serialCheckPassed = true;
				for (let s = 0; s < serialArray.length; s++) {
					const serial = serialArray[s];
					// 0 = any serial so always passes
					if (serial == 0) {
						continue;
					}
					else {
						// we need to check sender owns the serial
						const serialsOwned = serialsOwnedMap.get(tokenId);
						const indexOfSerial = serialsOwned.indexOf(serial);
						if (indexOfSerial < 0) {
							console.log(`[ERROR]: sender (${senderAccountId}) does not own serial (${serial}) of token (${tokenId}) specified to send to ${tfr.receiverWallet}`);
							tfr.message += `ERROR: requested to send a serial not owned ${tokenId} / #${serial} `;
							skippedTfr.push(tfr);
							serialCheckPassed = false;
						}
						else if (serialsOwned instanceof Array) {
							// need to remove the serial to avoid it being randomly allocated to another tx
							serialsOwned.splice(indexOfSerial, 1);
						}
					}
				}
				if (serialCheckPassed) nftTokenTfr.push(tfr);
			}
			else if (tokenType == 'HBAR') {
				hbarTfr.push(tfr);
			}
			else {
				fungibleTokenTfr.push(tfr);
			}

			const totalQty = (tokenQtyMap.get(tokenId) || 0) + Number(tfr.quantity);

			tokenQtyMap.set(tokenId, totalQty);
		}
	}

	// check we have enough tokens to meet the demand
	let enoughTokens = true;
	for (let t = 0; t < tokenArray.length; t++) {
		const tokenId = tokenArray[t];
		const requiredAmt = tokenQtyMap.get(tokenId);
		const ownedAmt = ownedTokenMap.get(tokenId);
		if (requiredAmt > ownedAmt) {
			console.log(`[INFO]: ${tokenId} -> Sending ${requiredAmt} / owned ${ownedAmt} -> **FAILED**`);
			enoughTokens = false;
		}
		else {
			console.log(`[INFO]: ${tokenId} -> Sending ${requiredAmt} / owned ${ownedAmt} -> PASSED`);
		}
	}

	if (!enoughTokens) {
		console.log('Not enough tokens to meet the requested distribution - exiting');
		exit(1);
	}
	else {
		console.log('Running pre-allocation and assigning random serials where needed (**NOT DETERMINISTIC**)');
	}

	// check NFTs first
	for (let n = 0; n < nftTokenTfr.length; n++) {
		const tfr = nftTokenTfr[n];
		if (tfr instanceof Transaction) {
			// switch out any serials for a random allocation from those owned
			const serialArr = tfr.serialArray;
			for (let s = 0; s < serialArr.length; s++) {
				let serial = serialArr[s];
				if (serial == 0) {
					// get a random serial
					// serials array is shuffeld upon collection
					const serialsAvailable = serialsOwnedMap.get(tfr.tokenId);
					serial = serialsAvailable.pop();
					serialArr.splice(s, 1, serial);
				}
			}

			console.log(`[INFO]: NFT transfer to ${tfr.receiverWallet} for ${tfr.quantity} of ${tfr.tokenId} [serial(s) ${tfr.getSerialString()} selected]`);
		}
	}
	// now fungible commons
	for (let f = 0; f < fungibleTokenTfr.length; f++) {
		const tfr = fungibleTokenTfr[f];
		if (tfr instanceof Transaction) {
			console.log(`[INFO]: Fungible transfer to ${tfr.receiverWallet} for ${tfr.quantity} of ${tfr.tokenId}`);
		}
	}

	for (let skp = 0; skp < skippedTfr.length; skp++) {
		const tfr = skippedTfr[skp];
		if (tfr instanceof Transaction) {
			console.log('[INFO]: Skipped in pre-flight check', tfr.toString());
		}
	}

	if (test) {
		console.log('TEST MODE: Exiting');
		exit(0);
	}

	// get details for Hedera network
	const myPrivateKey = PrivateKey.fromString(process.env.MY_PRIVATE_KEY);

	// If we weren't able to grab it, we should throw a new error
	if (senderAccountId == null ||
        myPrivateKey == null) {
		throw new Error('Environment variables for account ID / PKs / environment must be present');
	}

	if (env === undefined || env == null) {
		console.log('Environment required, please specify test or main in the .env file');
		return;
	}

	console.log(`Using account: ${senderAccountId} in ${env} environment with memo ${memo}`);

	let client;
	if (env == 'TEST') {
		client = Client.forTestnet();
		console.log('Sending tokens in *TESTNET*');
	}
	else if (env == 'MAIN') {
		client = Client.forMainnet();
		console.log('Sending tokens in *MAINNET*');
	}
	else {
		console.log('ERROR: Must specify either MAIN or TEST as environment in .env file');
		return;
	}

	client.setOperator(senderAccountId, myPrivateKey);

	// Now send the tokens!
	// process each NFT line seperately *BUT* need to batch if too many
	let nftBatchSize = 10;
	// step 1: break transactions into parts
	// process easch instruction seperately to ensure success/failure lines up (less efficient of course).
	// more important for NFTs given unique...FT can aggregate.
	for (let n = 0; n < nftTokenTfr.length; n++) {
		const tfr = nftTokenTfr[n];
		let txStatus = true;
		if (tfr instanceof Transaction) {
			const serialsList = tfr.serialArray;
			for (let outer = 0; outer < serialsList.length; outer += nftBatchSize) {
				const tokenTransferTx = new TransferTransaction();
				for (let inner = 0; (inner < nftBatchSize) && ((outer + inner) < serialsList.length); inner++) {
					const serial = serialsList[outer + inner];
					tokenTransferTx.addNftTransfer(tfr.tokenId, serial, senderAccountId, tfr.receiverWallet);
					if (verbose) console.log(`Adding serial ${serial} of ${tfr.tokenId} to tx to send to ${tfr.receiverWallet} from ${senderAccountId}`);
				}
				// assumes the account sending is treasury account
				if (verbose) console.log('Sending NFT(s)');
				tokenTransferTx
					.setTransactionMemo(memo)
					.freezeWith(client);

				// sign
				const signedTx = await tokenTransferTx.sign(myPrivateKey);
				// submit
				try {
					const tokenTransferSubmit = await signedTx.execute(client);
					// check it worked
					const tokenTransferRx = await tokenTransferSubmit.getReceipt(client);
					console.log('Tx processed - status:', tokenTransferRx.status.toString());
					if (tokenTransferRx.status.toString() != 'SUCCESS') txStatus = false;
				}
				catch (err) {
					console.log('Error occured executing tx:', err);
					txStatus = false;
				}
			}
			tfr.success = txStatus;
		}
	}

	// will be rare to send a list of different FC tokens in a single batch
	// ASSUMPTION: the token being sent is likely grouped so try and complete maximum tx in each batch (unles token changes)

	// update batch size to be 9 account and 1 -ve tx to debit treasury.
	nftBatchSize = 9;
	// not wrapped in try/catch as not recoverable anyway.
	for (let outer = 0; outer < fungibleTokenTfr.length; outer += nftBatchSize) {
		let tokenTransferTx = new TransferTransaction();
		let decimals;
		let pmtSum = 0;
		let lastToken = '';
		let txBeingProcessedIndex = [];
		let txStatus = true;
		for (let inner = 0; (inner < nftBatchSize) && ((outer + inner) < fungibleTokenTfr.length); inner++) {
			const tfr = fungibleTokenTfr[outer + inner];
			if (tfr instanceof Transaction) {
				const tokenToSend = tfr.tokenId;
				decimals = tokenDecimalsMap.get(tokenToSend);
				if (verbose) console.log(`using decimals ${decimals} for token ${tokenToSend}`);
				if (tokenToSend != lastToken) {
					if (pmtSum > 0) {
						// we need to process existing txs
						if (verbose) console.log(`(token shift) Adding treasury debit of ${-pmtSum} for ${lastToken} from ${senderAccountId}`);
						tokenTransferTx.addTokenTransfer(lastToken, senderAccountId, -pmtSum * (10 ** decimals));
						if (verbose) console.log('Processing transfer');
						tokenTransferTx
							.setTransactionMemo(memo)
							.freezeWith(client);
						// sign
						const signedTx = await tokenTransferTx.sign(myPrivateKey);
						// submit
						try {
							const tokenTransferSubmit = await signedTx.execute(client);
							// check it worked
							const tokenTransferRx = await tokenTransferSubmit.getReceipt(client);
							const rxStatus = tokenTransferRx.status.toString();
							console.log('Tx processed - status:', rxStatus);
							if (rxStatus != 'SUCCESS') txStatus = false;
						}
						catch (err) {
							console.log('Error occured executing tx:', err);
							txStatus = false;
						}

						for (let t = 0; t < txBeingProcessedIndex.length; t++) {
							fungibleTokenTfr[txBeingProcessedIndex[t]].success = txStatus;
						}
					}
					pmtSum = 0;
					lastToken = tokenToSend;
					txBeingProcessedIndex = [];
					tokenTransferTx = new TransferTransaction();
					txStatus = true;
				}
				const pmt = Number(tfr.quantity);
				pmtSum += pmt;
				tokenTransferTx.addTokenTransfer(tfr.tokenId, tfr.receiverWallet, tfr.quantity * (10 ** decimals));
				if (verbose) {
					console.log(`..adding transfer for ${tfr.quantity} of ${tfr.tokenId} to ${tfr.receiverWallet}.\t-> running total: ${pmtSum}`);
				}
				txBeingProcessedIndex.push((outer + inner));
			}
		}

		if (verbose) console.log(`Adding treasury debit of ${-pmtSum} for ${lastToken} from ${senderAccountId}`);
		tokenTransferTx.addTokenTransfer(lastToken, senderAccountId, -pmtSum * (10 ** decimals));
		if (verbose) console.log('Processing transfer');

		tokenTransferTx
			.setTransactionMemo(memo)
			.freezeWith(client);
		// sign
		const signedTx = await tokenTransferTx.sign(myPrivateKey);
		// submit
		try {
			const tokenTransferSubmit = await signedTx.execute(client);
			// check it worked
			const tokenTransferRx = await tokenTransferSubmit.getReceipt(client);
			const rxStatus = tokenTransferRx.status.toString();
			console.log('Tx processed - status:', rxStatus);
			if (rxStatus != 'SUCCESS') txStatus = false;
		}
		catch (err) {
			console.log('Error occured executing tx:', err);
			txStatus = false;
		}

		for (let t = 0; t < txBeingProcessedIndex.length; t++) {
			fungibleTokenTfr[txBeingProcessedIndex[t]].success = txStatus;
		}
	}
	// now process hbar transfers
	// not wrapped in try/catch as not recoverable anyway.

	for (let outer = 0; outer < hbarTfr.length; outer += nftBatchSize) {
		const tokenTransferTx = new TransferTransaction();
		let pmtSum = 0;
		const txBeingProcessedIndex = [];
		let txStatus = true;
		for (let inner = 0; (inner < nftBatchSize) && ((outer + inner) < hbarTfr.length); inner++) {
			const tfr = hbarTfr[outer + inner];
			if (tfr instanceof Transaction) {
				const pmt = Number(tfr.quantity);
				pmtSum = Math.round((pmtSum + pmt) * 1e8) / 1e8;
				tokenTransferTx.addHbarTransfer(tfr.receiverWallet, new Hbar(tfr.quantity, HbarUnit.Hbar));
				if (verbose) {
					console.log(`..adding transfer for ${tfr.quantity} of ${tfr.tokenId} to ${tfr.receiverWallet}.\t-> running total: ${pmtSum}`);
				}
				txBeingProcessedIndex.push((outer + inner));
			}
		}

		if (verbose) console.log(`Adding treasury debit of ${-pmtSum} HBAR from ${senderAccountId}`);
		tokenTransferTx.addHbarTransfer(senderAccountId, new Hbar(-pmtSum, HbarUnit.Hbar));
		if (verbose) console.log('Processing transfer');

		tokenTransferTx
			.setTransactionMemo(memo)
			.freezeWith(client);
		// sign
		const signedTx = await tokenTransferTx.sign(myPrivateKey);
		// submit
		try {
			const tokenTransferSubmit = await signedTx.execute(client);
			// check it worked
			const tokenTransferRx = await tokenTransferSubmit.getReceipt(client);
			const rxStatus = tokenTransferRx.status.toString();
			console.log('Tx processed - status:', rxStatus);
			if (rxStatus != 'SUCCESS') txStatus = false;
		}
		catch (err) {
			console.log('Error occured executing tx:', err);
			txStatus = false;
		}

		for (let t = 0; t < txBeingProcessedIndex.length; t++) {
			hbarTfr[txBeingProcessedIndex[t]].success = txStatus;
		}
	}

	// TODO keep a log of user tokens before and after to check it worked
	// subject to mirror node refresh speed...

	// this will reorder the lines -- if user feedback request could maintain ordering
	// concat to an empty array to be sure we always pass back something.
	return [[...nftTokenTfr, ...fungibleTokenTfr, ...hbarTfr], skippedTfr];
}

async function getTokenBalanceMap(tokenId) {

	let routeUrl = '/api/v1/tokens/' + tokenId + '/balances/';
	const baseUrl = env == 'MAIN' ? baseUrlForMainnet : baseUrlForTestnet;
	const tokenBalMap = new Map();
	try {
		do {
			if (verbose) console.log(baseUrl + routeUrl);
			const json = await fetchJson(baseUrl + routeUrl);
			if (json == null) {
				console.log('FATAL ERROR: no NFTs found', baseUrl + routeUrl);
				// unlikely to get here but a sensible default
				return;
			}

			for (let b = 0 ; b < json.balances.length; b++) {
				const entry = json.balances[b];
				const account = entry.account;
				const balance = entry.balance;

				tokenBalMap.set(account, balance);
			}

			routeUrl = json.links.next;
		}
		while (routeUrl);
		if (verbose) console.log(tokenBalMap);
		return tokenBalMap;
	}
	catch (err) {
		console.log('Trying to find balances for', tokenId, baseUrl, routeUrl);
		console.error(err);
		exit(1);
	}
}

async function getSerialsOwned(tokenId, wallet, excludeSerialsList = []) {
	const baseUrl = env == 'MAIN' ? baseUrlForMainnet : baseUrlForTestnet;

	const serialArr = [];
	let routeUrl = '/api/v1/tokens/' + tokenId + '/nfts?account.id=' + wallet;

	console.log('Fetching serials owned: ', baseUrl + routeUrl);

	try {
		do {
			const json = await fetchJson(baseUrl + routeUrl);

			for (let n = 0; n < json.nfts.length; n++) {
				const nft = json.nfts[n];
				const serial = nft.serial_number;
				if (!excludeSerialsList.includes(serial)) serialArr.push(serial);
			}

			routeUrl = json.links.next;
		}
		while (routeUrl);

		// ensure the array of serials is randomised.
		return shuffleArray(serialArr);
	}
	catch (err) {
		console.log('Trying to find serials owned', wallet, baseUrl, routeUrl, serialArr);
		console.error(err);
		exit(1);
	}
}

async function getHbarBalance(accountId) {
	const baseUrl = env == 'MAIN' ? baseUrlForMainnet : baseUrlForTestnet;
	const routeUrl = `/api/v1/accounts/${accountId}/`;

	const accountJSON = await fetchJson(baseUrl + routeUrl);

	const acctBalance = accountJSON.balance.balance * 10 ** -8;

	return acctBalance;
}

async function getTokenType(tokenId) {
	const baseUrl = env == 'MAIN' ? baseUrlForMainnet : baseUrlForTestnet;
	const routeUrl = `/api/v1/tokens/${tokenId}`;

	const tokenDetailJSON = await fetchJson(baseUrl + routeUrl);

	return [tokenDetailJSON.type, tokenDetailJSON.decimals];
}

async function fetchJson(url, depth = 0) {
	if (depth >= maxRetries) return null;
	if (depth > (maxRetries / 2) && verbose) console.log('Attempt: ', depth, url);
	depth++;
	try {
		const res = await fetchWithTimeout(url);
		if (res.status != 200) {
			await sleep(500 * depth);
			return await fetchJson(url, depth);
		}
		return res.json();
	}
	catch (err) {
		await sleep(500 * depth);
		return await fetchJson(url, depth);
	}
}

function getArg(arg) {
	const customIndex = process.argv.indexOf(`-${arg}`);
	let customValue;

	if (customIndex > -1) {
		// Retrieve the value after --custom
		customValue = process.argv[customIndex + 1];
	}

	return customValue;
}

function getArgFlag(arg) {
	const customIndex = process.argv.indexOf(`-${arg}`);

	if (customIndex > -1) {
		return true;
	}

	return false;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(resource, options = {}) {
	const { timeout = 30000 } = options;
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeout);
	const response = await fetch(resource, {
		...options,
		signal: controller.signal,
	});
	clearTimeout(id);
	return response;
}

function shuffleArray(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

async function main() {
	if (getArgFlag('h')) {
		console.log('Usage: node tokenAirdrop.js -process <file> [-test] [-v]');
		console.log('       -process <file>		the tokens to send');
		console.log('       -test				process the file but nothign sent');
		console.log('       -v          		verbose [debug]');
		return;
	}

	console.log('Using ENIVRONMENT:', env);
	console.log('Using MEMO:', memo);

	verbose = getArgFlag('v');

	const processFlag = getArgFlag('process');
	const processFile = getArg('process');

	const test = getArgFlag('test');

	if (!processFlag) {
		console.log('**MUST** specify a file to process -> -process <file>');
		return;
	}

	// null implies NotApplicable
	let maxTferAmt = null;
	try {
		maxTferAmt = Number(process.env.MAX_TRANSFER) || null;
		if (maxTferAmt <= 0) maxTferAmt = null;
	}
	catch (_err) {
		// swallow the error and assume no limit
		maxTferAmt = null;
	}
	console.log('Using MAX_TRANSFER:', maxTferAmt);

	const excludeWalletsEnv = process.env.EXCLUDE_WALLETS;
	console.log('Using EXCLUDE WALLETS:', excludeWalletsEnv);
	let excludeWalletsList = [];
	if (excludeWalletsEnv !== undefined) {
		excludeWalletsList = [].concat(excludeWalletsEnv.split(','));
	}

	// read in file to process
	const [tfrArray, skippedTfrs, tokenBalancesMaps] = await readDB(processFile, maxTferAmt, excludeWalletsList) ?? [[], [], new Map()];

	const excludeSerialsEnv = process.env.EXCLUDE_SERIALS || null;
	console.log('Using EXCLUDE_SERIALS:', excludeSerialsEnv);
	const excludeSerialsList = [];
	try {
		if (excludeSerialsEnv === undefined || excludeSerialsEnv == null || excludeSerialsEnv == '') {
			// no serials to exclude
			if (verbose) console.log('**NO SERIALS TO EXCLUDE**');
		}
		// format csv or '-' for range
		else if (excludeSerialsEnv.includes('-')) {
		// inclusive range
			const rangeSplit = excludeSerialsEnv.split('-');
			for (let i = rangeSplit[0]; i <= rangeSplit[1]; i++) {
				excludeSerialsList.push(i);
			}
		}
		else if (excludeSerialsEnv.includes(',')) {
			const csvSplit = excludeSerialsEnv.split(',');
			for (let i = 0; i <= csvSplit.length; i++) {
				const serial = Number(csvSplit[i]);
				// ignore NaN / trailing junk
				if (serial) excludeSerialsList.push(serial);
			}
		}
		else {
		// only one serial to check
			excludeSerialsList.push(Number(excludeSerialsEnv));
		}
		console.log('Serials marked for exclusion', excludeSerialsList);
	}
	catch (err) {
		console.log('ERROR on defining serials to exclude', excludeSerialsEnv);
		exit(1);
	}

	if (processFlag) {
		// process the payment file
		processTransfers(tfrArray, tokenBalancesMaps, excludeSerialsList, test).then(([processedTfrs, moreSkippedTfrs]) => {
			const allSkippedTfrs = [...skippedTfrs, ...moreSkippedTfrs];
			if (verbose) {
				console.log('Processed tx:', processedTfrs);
				console.log('Skipped tx:', allSkippedTfrs);
			}
			writeDB(processedTfrs, allSkippedTfrs, processFile);
		});
	}
}

main();