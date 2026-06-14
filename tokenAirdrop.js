/**
 * Hedera Token Airdrop Script v1.0.0
 * 
 * Supports parallel processing, resume capability, and progress tracking
 * for airdrops of NFTs, Fungible Tokens, and HBAR on Hedera network
 */

import {
	PrivateKey,
	Client,
	TransferTransaction,
	Hbar,
	HbarUnit,
	AccountId,
	TransactionId,
} from '@hashgraph/sdk';
import 'dotenv/config';
import * as fs from 'fs';
import fetch from 'cross-fetch';
import { exit } from 'process';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * @typedef {Object} Config
 * @property {string} network - Network to use (mainnet/testnet/previewnet/custom)
 * @property {string} mirrorNodeUrl - Mirror node base URL
 * @property {string} senderAccountId - Account sending tokens
 * @property {string} privateKey - Private key for sender
 * @property {number|null} maxTransferPerWallet - Max tokens per wallet
 * @property {number} maxConcurrentTxs - Max concurrent transactions
 * @property {string} memo - Transaction memo
 * @property {string[]} excludeWallets - Wallets to skip
 * @property {number[]} excludeSerials - NFT serials to exclude
 * @property {boolean} verbose - Enable verbose logging
 * @property {boolean} isApproval - Using allowance approval
 * @property {AccountId|null} approvalAcct - Approval account if applicable
 */

/**
 * Build configuration from environment and CLI args
 * @returns {Config}
 */
function buildConfig() {
	// Backward compatibility: check ENVIRONMENT first, then NETWORK
	let network = process.env.NETWORK;
	if (!network) {
		const oldEnv = process.env.ENVIRONMENT;
		if (oldEnv === 'MAIN') {
			network = 'mainnet';
		} else if (oldEnv === 'TEST') {
			network = 'testnet';
		} else {
			network = 'mainnet'; // default
		}
	}
	network = network.toLowerCase();

	// Mirror node URL construction
	let mirrorNodeUrl;
	if (network === 'custom') {
		mirrorNodeUrl = process.env.CUSTOM_MIRROR_URL;
		if (!mirrorNodeUrl) {
			throw new Error('CUSTOM_MIRROR_URL must be set when NETWORK=custom');
		}
	} else if (['mainnet', 'testnet', 'previewnet'].includes(network)) {
		mirrorNodeUrl = `https://${network}.mirrornode.hedera.com`;
	} else {
		throw new Error(`Invalid NETWORK: ${network}. Use mainnet, testnet, previewnet, or custom`);
	} const senderAccountId = process.env.MY_ACCOUNT_ID;
	const privateKey = process.env.MY_PRIVATE_KEY;

	if (!senderAccountId || !privateKey) {
		throw new Error('MY_ACCOUNT_ID and MY_PRIVATE_KEY must be set in .env');
	}

	// Parse max transfer
	let maxTransferPerWallet = null;
	try {
		const val = Number(process.env.MAX_TRANSFER);
		if (val > 0) maxTransferPerWallet = val;
	} catch (_err) {
		// Swallow error, no limit
	}

	// Parse max concurrent txs
	let maxConcurrentTxs = 50;
	try {
		const val = Number(process.env.MAX_CONCURRENT_TXS);
		if (val > 0) maxConcurrentTxs = val;
	} catch (_err) {
		// Use default
	}

	// Parse exclude wallets
	const excludeWalletsEnv = process.env.EXCLUDE_WALLETS || '';
	const excludeWallets = excludeWalletsEnv ? excludeWalletsEnv.split(',').map(w => w.trim()) : [];

	// Parse exclude serials
	const excludeSerialsEnv = process.env.EXCLUDE_SERIALS || '';
	const excludeSerials = parseExcludeSerials(excludeSerialsEnv);

	// CLI flags
	const verbose = getArgFlag('v');
	const isApproval = getArgFlag('approval');
	const approvalAcct = isApproval ? AccountId.fromString(getArg('approval')) : null;

	return {
		network,
		mirrorNodeUrl,
		senderAccountId,
		privateKey,
		maxTransferPerWallet,
		maxConcurrentTxs,
		memo: process.env.MEMO || 'Airdrop',
		excludeWallets,
		excludeSerials,
		verbose,
		isApproval,
		approvalAcct,
	};
}

/**
 * Parse exclude serials from string
 * @param {string} serialsStr - Serials string (csv or range)
 * @returns {number[]}
 */
function parseExcludeSerials(serialsStr) {
	if (!serialsStr || serialsStr.trim() === '') return [];

	const excludeSerials = [];
	try {
		if (serialsStr.includes('-')) {
			// Range format: 1-100
			const [start, end] = serialsStr.split('-').map(Number);
			for (let i = start; i <= end; i++) {
				excludeSerials.push(i);
			}
		} else if (serialsStr.includes(',')) {
			// CSV format: 1,2,3,4
			const parts = serialsStr.split(',');
			for (const part of parts) {
				const serial = Number(part.trim());
				if (!isNaN(serial)) excludeSerials.push(serial);
			}
		} else {
			// Single serial
			const serial = Number(serialsStr);
			if (!isNaN(serial)) excludeSerials.push(serial);
		}
	} catch (err) {
		console.error('ERROR: Failed to parse EXCLUDE_SERIALS:', serialsStr);
		exit(1);
	}
	return excludeSerials;
}

// ============================================================================
// TRANSACTION DATA MODEL
// ============================================================================

/**
 * Represents a single token transfer transaction
 */
class Transaction {
	/**
	 * @param {string} receiverWallet - Destination wallet
	 * @param {string} tokenId - Token ID or 'hbar'
	 * @param {number} quantity - Amount to send
	 * @param {number[]} serialArray - NFT serials (or [0] for FT/hbar)
	 * @param {string} message - Status/error message
	 * @param {boolean} success - Whether tx succeeded
	 * @param {boolean} allocateSerials - Whether to pad serial array
	 */
	constructor(receiverWallet, tokenId, quantity, serialArray, message, success, allocateSerials = true) {
		this.receiverWallet = receiverWallet;
		this.tokenId = tokenId;
		this.quantity = quantity;
		this.serialArray = [];

		const sA = serialArray.slice(0, quantity);
		for (const s of sA) {
			this.serialArray.push(Number(s));
		}

		// Ensure serial array matches quantity
		if (allocateSerials) {
			while (this.serialArray.length < this.quantity) {
				this.serialArray.push(0);
			}
		}

		this.message = message;
		this.success = success;
		this.txId = null;
		this.retryCount = 0;
	}

	/**
	 * Get serials as comma-separated string
	 * @returns {string}
	 */
	getSerialString() {
		return this.serialArray.join(',');
	}

	/**
	 * Convert to CSV row format
	 * @returns {string}
	 */
	toCsvRow() {
		return `${this.receiverWallet},${this.tokenId},${this.quantity},${this.getSerialString()},${this.message},${this.txId || ''}`;
	}

	/**
	 * Update serials array
	 * @param {number[]} newSerialArray
	 */
	setSerials(newSerialArray) {
		this.serialArray = newSerialArray;
	}

	/**
	 * Convert to JSON for output
	 * @returns {Object}
	 */
	toJSON() {
		return {
			receiverWallet: this.receiverWallet,
			tokenId: this.tokenId,
			quantity: this.quantity,
			serials: this.serialArray,
			message: this.message,
			success: this.success,
			txId: this.txId,
			retryCount: this.retryCount,
		};
	}
}

// ============================================================================
// CHECKPOINT SYSTEM
// ============================================================================

/**
 * Save checkpoint to allow resume
 * @param {string} filename - Base filename being processed
 * @param {Transaction[]} completed - Completed transactions
 * @param {Transaction[]} pending - Pending transactions
 */
function saveCheckpoint(filename, completed, pending) {
	const checkpointFile = `.checkpoint_${filename.replace(/[^a-zA-Z0-9]/g, '_')}`;
	const checkpoint = {
		timestamp: new Date().toISOString(),
		filename,
		completed: completed.map(t => t.toJSON()),
		pending: pending.map(t => t.toJSON()),
	};

	try {
		fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));
	} catch (err) {
		console.error('Warning: Failed to save checkpoint:', err.message);
	}
}

/**
 * Load checkpoint if exists
 * @param {string} filename - Base filename being processed
 * @returns {Object|null} - Checkpoint data or null
 */
function loadCheckpoint(filename) {
	const checkpointFile = `.checkpoint_${filename.replace(/[^a-zA-Z0-9]/g, '_')}`;

	try {
		if (fs.existsSync(checkpointFile)) {
			const data = fs.readFileSync(checkpointFile, 'utf-8');
			return JSON.parse(data);
		}
	} catch (err) {
		console.error('Warning: Failed to load checkpoint:', err.message);
	}

	return null;
}

/**
 * Delete checkpoint file
 * @param {string} filename - Base filename being processed
 */
function deleteCheckpoint(filename) {
	const checkpointFile = `.checkpoint_${filename.replace(/[^a-zA-Z0-9]/g, '_')}`;

	try {
		if (fs.existsSync(checkpointFile)) {
			fs.unlinkSync(checkpointFile);
		}
	} catch (err) {
		console.error('Warning: Failed to delete checkpoint:', err.message);
	}
}

/**
 * Restore transactions from checkpoint
 * @param {Object} checkpoint - Checkpoint data
 * @returns {[Transaction[], Transaction[]]} - [completed, pending]
 */
function restoreFromCheckpoint(checkpoint) {
	const completed = checkpoint.completed.map(data => {
		const tx = new Transaction(
			data.receiverWallet,
			data.tokenId,
			data.quantity,
			data.serials,
			data.message,
			data.success,
			false
		);
		tx.txId = data.txId;
		tx.retryCount = data.retryCount;
		return tx;
	});

	const pending = checkpoint.pending.map(data => {
		const tx = new Transaction(
			data.receiverWallet,
			data.tokenId,
			data.quantity,
			data.serials,
			data.message,
			data.success,
			false
		);
		tx.retryCount = data.retryCount;
		return tx;
	});

	return [completed, pending];
}

// ============================================================================
// LOGGING & PROGRESS
// ============================================================================

/**
 * Log with timestamp
 * @param {string} level - Log level (INFO, WARN, ERROR)
 * @param {string} message - Message to log
 * @param {Config} config - Configuration
 */
function log(level, message, config) {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] [${level}] ${message}`);
}

/**
 * Show progress bar
 * @param {number} current - Current progress
 * @param {number} total - Total items
 * @param {string} label - Progress label
 */
function showProgress(current, total, label = 'Progress') {
	const percentage = Math.round((current / total) * 100);
	const barLength = 40;
	const filledLength = Math.round((barLength * current) / total);
	const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

	process.stdout.write(`\r${label}: [${bar}] ${percentage}% (${current}/${total})`);

	if (current === total) {
		process.stdout.write('\n');
	}
}

// ============================================================================
// FILE I/O
// ============================================================================

/**
 * Read and parse CSV file
 * @param {string} filePath - Path to CSV file
 * @param {Config} config - Configuration
 * @returns {Promise<[Transaction[], Transaction[], Map]>} - [transfers, skipped, tokenBalanceMaps]
 */
async function readAirdropFile(filePath, config) {
	const tokenTransfers = [];
	const skippedTfrs = [];
	const userAmtMap = new Map();
	const tokenBalancesMaps = new Map();

	// Ensure file exists
	if (!fs.existsSync(filePath)) {
		console.log(`File ${filePath} does not exist. Creating empty file.`);
		fs.writeFileSync(filePath, '# destWallet,tokenToSend,quantity,serial(s)\n');
		throw new Error(`Created empty file at ${filePath}. Please add airdrop data and run again.`);
	}

	const allFileContents = fs.readFileSync(filePath, 'utf-8');
	const lines = allFileContents.split(/\r?\n/);

	log('INFO', `Processing ${lines.length} lines from ${filePath}`, config);

	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum].trim();

		// Skip empty lines and comments
		if (!line || line.startsWith('#')) continue;

		// Validate wallet format
		if (!/^0\.0\.[1-9][0-9]+,/i.test(line)) {
			log('WARN', `Line ${lineNum + 1}: Skipping - invalid wallet format: ${line}`, config);
			continue;
		}

		const parts = line.split(',');
		if (parts.length < 3) {
			log('WARN', `Line ${lineNum + 1}: Skipping - insufficient columns: ${line}`, config);
			continue;
		}

		const [receiverWallet, tokenId, qtyStr, ...serialParts] = parts;
		const quantity = Number(qtyStr);
		const serialArray = serialParts.length === 0 ? [0] : serialParts.map(s => Number(s.trim())).filter(s => !isNaN(s));

		if (isNaN(quantity) || quantity <= 0) {
			log('WARN', `Line ${lineNum + 1}: Skipping - invalid quantity: ${line}`, config);
			const tx = new Transaction(receiverWallet, tokenId, 0, [0], 'INVALID QUANTITY: **SKIPPED**', false, false);
			skippedTfrs.push(tx);
			continue;
		}

		// Check wallet association for tokens (not hbar)
		let walletAssociated = true;
		if (tokenId.toLowerCase() !== 'hbar') {
			// Check if this specific wallet has the token associated
			walletAssociated = await checkWalletTokenAssociation(receiverWallet, tokenId, config);

			// Still build balance map for sender validation later
			if (walletAssociated && !tokenBalancesMaps.has(tokenId)) {
				if (config.verbose) log('INFO', `Building token/balance map for ${tokenId}`, config);
				const tokenBalMap = await getTokenBalanceMap(tokenId, config);
				tokenBalancesMaps.set(tokenId, tokenBalMap);
			}
		}

		// Apply exclusions and limits
		let amt = userAmtMap.get(receiverWallet) || 0;

		if (config.excludeWallets.includes(receiverWallet)) {
			const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, 'EXCLUDED WALLET: **SKIPPED**', false, false);
			skippedTfrs.push(tx);
		} else if (!walletAssociated) {
			const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, 'NOT ASSOCIATED: **SKIPPED**', false, false);
			skippedTfrs.push(tx);
		} else if (config.maxTransferPerWallet !== null && (amt + quantity) > config.maxTransferPerWallet) {
			const remCapacity = config.maxTransferPerWallet - amt;
			if (remCapacity > 0) {
				amt += remCapacity;
				const tx = new Transaction(receiverWallet, tokenId, remCapacity, serialArray, `MAX TRANSFER LIMIT: Reduced by ${quantity - remCapacity}`, false);
				tokenTransfers.push(tx);
			} else {
				const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, 'MAX TRANSFER LIMIT: **SKIPPED**', false, false);
				skippedTfrs.push(tx);
			}
		} else {
			const tx = new Transaction(receiverWallet, tokenId, quantity, serialArray, '', false);
			tokenTransfers.push(tx);
			amt += quantity;
		}

		userAmtMap.set(receiverWallet, amt);
	}

	log('INFO', `Loaded ${tokenTransfers.length} transfers, ${skippedTfrs.length} skipped`, config);
	return [tokenTransfers, skippedTfrs, tokenBalancesMaps];
}

/**
 * Write results to CSV and JSON
 * @param {Transaction[]} completed - Completed transactions
 * @param {Transaction[]} skipped - Skipped transactions
 * @param {Transaction[]} failed - Failed transactions
 * @param {string} filename - Original filename
 * @param {Config} config - Configuration
 */
function writeResults(completed, skipped, failed, filename, config) {
	const timestamp = new Date().toISOString();
	// Extract just the filename without path or extension
	const baseName = filename
		.replace(/\\/g, '/') // normalize Windows paths
		.split('/').pop() // get just the filename
		.replace(/\.csv$/i, ''); // remove .csv extension

	// CSV Output (human-readable)
	const csvFilename = `output_${baseName}_${timestamp.replace(/[:.]/g, '-')}.csv`;
	let csvContent = `# Airdrop Results - ${timestamp}\n`;
	csvContent += `# Status,Destination,Token,Quantity,Serials,Message,TransactionID\n`;

	for (const tx of completed) {
		csvContent += `SUCCESS,${tx.toCsvRow()}\n`;
	}
	for (const tx of failed) {
		csvContent += `FAILED,${tx.toCsvRow()}\n`;
	}
	for (const tx of skipped) {
		csvContent += `SKIPPED,${tx.toCsvRow()}\n`;
	}

	fs.writeFileSync(csvFilename, csvContent);
	log('INFO', `Results written to ${csvFilename}`, config);

	// JSON Output (machine-readable)
	const jsonFilename = `output_${baseName}_${timestamp.replace(/[:.]/g, '-')}.json`;
	const jsonOutput = {
		timestamp,
		summary: {
			total: completed.length + failed.length + skipped.length,
			completed: completed.length,
			failed: failed.length,
			skipped: skipped.length,
		},
		transactions: {
			completed: completed.map(t => t.toJSON()),
			failed: failed.map(t => t.toJSON()),
			skipped: skipped.map(t => t.toJSON()),
		},
	};

	fs.writeFileSync(jsonFilename, JSON.stringify(jsonOutput, null, 2));
	log('INFO', `JSON results written to ${jsonFilename}`, config);

	// Print summary
	console.log('\n' + '='.repeat(60));
	console.log('AIRDROP SUMMARY');
	console.log('='.repeat(60));
	console.log(`✓ Completed: ${completed.length}`);
	console.log(`✗ Failed:    ${failed.length}`);
	console.log(`⊗ Skipped:   ${skipped.length}`);
	console.log(`  Total:     ${completed.length + failed.length + skipped.length}`);
	console.log('='.repeat(60));
}

// ============================================================================
// MIRROR NODE API
// ============================================================================

/**
 * Fetch JSON with retries and exponential backoff
 * @param {string} url - URL to fetch
 * @param {number} maxRetries - Max retry attempts
 * @param {number} depth - Current retry depth
 * @returns {Promise<Object|null>}
 */
async function fetchJson(url, maxRetries = 10, depth = 0) {
	if (depth >= maxRetries) {
		console.error(`Max retries (${maxRetries}) exceeded for: ${url}`);
		return null;
	}

	try {
		const res = await fetchWithTimeout(url, { timeout: 30000 });
		if (res.status === 200) {
			return await res.json();
		}

		// Exponential backoff
		const delay = Math.min(1000 * Math.pow(2, depth), 30000);
		await sleep(delay);
		return await fetchJson(url, maxRetries, depth + 1);
	} catch (err) {
		const delay = Math.min(1000 * Math.pow(2, depth), 30000);
		await sleep(delay);
		return await fetchJson(url, maxRetries, depth + 1);
	}
}

/**
 * Fetch with timeout
 * @param {string} resource - URL
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(resource, options = {}) {
	const { timeout = 30000 } = options;
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(resource, {
			...options,
			signal: controller.signal,
		});
		clearTimeout(id);
		return response;
	} catch (err) {
		clearTimeout(id);
		throw err;
	}
}

/**
 * Check if a wallet has a token associated
 * @param {string} wallet - Wallet address
 * @param {string} tokenId - Token ID
 * @param {Config} config - Configuration
 * @returns {Promise<boolean>}
 */
async function checkWalletTokenAssociation(wallet, tokenId, config) {
	try {
		const routeUrl = `/api/v1/accounts/${wallet}/tokens?token.id=${tokenId}`;
		const json = await fetchJson(config.mirrorNodeUrl + routeUrl);

		if (!json || !json.tokens || json.tokens.length === 0) {
			return false;
		}

		// Token is associated if it appears in the response
		return true;
	} catch (err) {
		if (config.verbose) log('WARN', `Could not check association for ${wallet}/${tokenId}: ${err.message}`, config);
		return false;
	}
}

/**
 * Get sender's balance for a specific token
 * @param {string} tokenId - Token ID
 * @param {string} accountId - Account ID
 * @param {Config} config - Configuration
 * @returns {Promise<number>}
 */
async function getSenderTokenBalance(tokenId, accountId, config) {
	try {
		const routeUrl = `/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`;
		const json = await fetchJson(config.mirrorNodeUrl + routeUrl);

		if (!json || !json.tokens || json.tokens.length === 0) {
			return 0;
		}

		return json.tokens[0].balance || 0;
	} catch (err) {
		if (config.verbose) log('WARN', `Could not fetch balance for ${accountId}/${tokenId}: ${err.message}`, config);
		return 0;
	}
}

/**
 * Get token balance map for all holders (only used when needed)
 * @param {string} tokenId - Token ID
 * @param {Config} config - Configuration
 * @returns {Promise<Map<string, number>>}
 */
async function getTokenBalanceMap(tokenId, config) {
	const tokenBalMap = new Map();
	let routeUrl = `/api/v1/tokens/${tokenId}/balances/`;
	let pageCount = 0;

	try {
		log('INFO', `Fetching balance data for ${tokenId}...`, config);
		do {
			pageCount++;
			if (pageCount % 10 === 0) {
				process.stdout.write(`\r  Loaded ${tokenBalMap.size} token holders...`);
			}

			const json = await fetchJson(config.mirrorNodeUrl + routeUrl);
			if (!json) {
				console.error(`ERROR: No balances found for ${tokenId}`);
				exit(1);
			}

			for (const entry of json.balances) {
				tokenBalMap.set(entry.account, entry.balance);
			}

			routeUrl = json.links.next;
		} while (routeUrl);

		if (pageCount >= 10) {
			process.stdout.write(`\r  ✓ Loaded ${tokenBalMap.size} token holders\n`);
		}
		return tokenBalMap;
	} catch (err) {
		console.error(`Error fetching balances for ${tokenId}:`, err);
		exit(1);
	}
}

/**
 * Get serials owned by wallet
 * @param {string} tokenId - Token ID
 * @param {string} wallet - Wallet address
 * @param {number[]} excludeSerials - Serials to exclude
 * @param {Config} config - Configuration
 * @returns {Promise<number[]>}
 */
async function getSerialsOwned(tokenId, wallet, excludeSerials, config) {
	const serialArr = [];
	let routeUrl = `/api/v1/tokens/${tokenId}/nfts?account.id=${wallet}`;

	try {
		do {
			const json = await fetchJson(config.mirrorNodeUrl + routeUrl);
			if (!json) break;

			for (const nft of json.nfts) {
				const serial = nft.serial_number;
				if (!excludeSerials.includes(serial)) {
					serialArr.push(serial);
				}
			}

			routeUrl = json.links.next;
		} while (routeUrl);

		return shuffleArray(serialArr);
	} catch (err) {
		console.error(`Error fetching serials for ${tokenId}/${wallet}:`, err);
		exit(1);
	}
}

/**
 * Get HBAR balance
 * @param {string} accountId - Account ID
 * @param {Config} config - Configuration
 * @returns {Promise<number>}
 */
async function getHbarBalance(accountId, config) {
	const routeUrl = `/api/v1/accounts/${accountId}/`;
	const json = await fetchJson(config.mirrorNodeUrl + routeUrl);
	return json.balance.balance * 1e-8;
}

/**
 * Get token type and decimals
 * @param {string} tokenId - Token ID
 * @param {Config} config - Configuration
 * @returns {Promise<[string, number]>}
 */
async function getTokenType(tokenId, config) {
	const routeUrl = `/api/v1/tokens/${tokenId}`;
	const json = await fetchJson(config.mirrorNodeUrl + routeUrl);
	return [json.type, json.decimals];
}

/**
 * Look up a transaction's consensus result on the mirror node.
 * Used to detect a tx that actually reached consensus even though the client
 * failed to fetch its receipt — avoids a blind resubmit that would collide
 * (e.g. SENDER_DOES_NOT_OWN_NFT_SERIAL_NO when the original already moved the NFT).
 * @param {string} txId - SDK transaction id (e.g. 0.0.x@sss.nnnnnnnnn)
 * @param {Config} config - Configuration
 * @returns {Promise<string|null>} - Result string (e.g. 'SUCCESS') or null if not found
 */
async function getTxResultFromMirror(txId, config) {
	if (!txId) return null;

	const [acct, ts] = txId.split('@');
	if (!acct || !ts) return null;
	const mirrorId = `${acct}-${ts.replace('.', '-')}`;
	const url = `${config.mirrorNodeUrl}/api/v1/transactions/${mirrorId}`;

	// Poll briefly to allow for mirror node ingestion lag (typically a few seconds)
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			const res = await fetchWithTimeout(url, { timeout: 15000 });
			if (res.status === 200) {
				const json = await res.json();
				if (json && Array.isArray(json.transactions) && json.transactions.length > 0) {
					return json.transactions[0].result;
				}
			}
		} catch (_err) {
			// Ignore and retry
		}
		await sleep(2000);
	}

	return null;
}

// ============================================================================
// TRANSACTION PROCESSING
// ============================================================================

/**
 * Pre-flight validation and serial allocation
 * @param {Transaction[]} transfers - Transfers to validate
 * @param {Map} tokenBalancesMaps - Token balance maps
 * @param {Config} config - Configuration
 * @returns {Promise<[Transaction[], Transaction[], Transaction[], Transaction[], Map]>} - [nft, ft, hbar, skipped, tokenDecimals]
 */
async function validateAndPrepareTransfers(transfers, tokenBalancesMaps, config) {
	log('INFO', 'Starting pre-flight validation...', config);

	const nftTransfers = [];
	const ftTransfers = [];
	const hbarTransfers = [];
	const skipped = [];

	const tokenTypeMap = new Map();
	const tokenDecimalsMap = new Map();
	const tokenQtyMap = new Map();
	const ownedTokenMap = new Map();
	const serialsOwnedMap = new Map();

	// Build token metadata
	const uniqueTokens = [...new Set(transfers.map(t => t.tokenId.toLowerCase()))];
	let tokenIndex = 0;
	log('INFO', `Analyzing ${uniqueTokens.length} unique token(s)...`, config);

	for (const tfr of transfers) {
		const tokenId = tfr.tokenId.toLowerCase();

		if (tokenTypeMap.has(tokenId)) continue;

		tokenIndex++;
		log('INFO', `[${tokenIndex}/${uniqueTokens.length}] Processing ${tokenId}...`, config);

		if (tokenId === 'hbar') {
			tokenTypeMap.set(tokenId, 'HBAR');
			const hbarBal = await getHbarBalance(config.senderAccountId, config);
			ownedTokenMap.set(tokenId, hbarBal);
		} else {
			const [tokenType, decimals] = await getTokenType(tokenId, config);
			tokenTypeMap.set(tokenId, tokenType);
			tokenDecimalsMap.set(tokenId, decimals);

			// Get sender's balance for this token
			const bal = await getSenderTokenBalance(tokenId, config.senderAccountId, config);

			if (tokenType === 'NON_FUNGIBLE_UNIQUE') {
				const serialsOwned = await getSerialsOwned(tokenId, config.senderAccountId, config.excludeSerials, config);
				serialsOwnedMap.set(tokenId, serialsOwned);
				ownedTokenMap.set(tokenId, serialsOwned.length);
			} else if (tokenType === 'FUNGIBLE_COMMON') {
				const balDecimalAdjusted = bal * Math.pow(10, -decimals);
				ownedTokenMap.set(tokenId, balDecimalAdjusted);
			} else {
				log('ERROR', `Invalid token type for ${tokenId}: ${tokenType}`, config);
				tfr.message = `ERROR: Invalid token type ${tokenType}`;
				skipped.push(tfr);
				continue;
			}
		}
	}

	// Validate and categorize transfers
	for (const tfr of transfers) {
		const tokenId = tfr.tokenId.toLowerCase();
		const tokenType = tokenTypeMap.get(tokenId);

		// Track total quantity per token
		const totalQty = (tokenQtyMap.get(tokenId) || 0) + tfr.quantity;
		tokenQtyMap.set(tokenId, totalQty);

		if (tokenType === 'NON_FUNGIBLE_UNIQUE') {
			// Validate NFT serials
			const serialArray = tfr.serialArray;
			const anyExcluded = serialArray.some(s => config.excludeSerials.includes(s));

			if (anyExcluded) {
				tfr.message = 'ERROR: Requested serial is on EXCLUDE list';
				skipped.push(tfr);
				continue;
			}

			let serialCheckPassed = true;
			for (let i = 0; i < serialArray.length; i++) {
				const serial = serialArray[i];
				if (serial === 0) continue;

				const serialsOwned = serialsOwnedMap.get(tokenId);
				const idx = serialsOwned.indexOf(serial);
				if (idx < 0) {
					tfr.message = `ERROR: Sender does not own serial ${serial}`;
					skipped.push(tfr);
					serialCheckPassed = false;
					break;
				} else {
					serialsOwned.splice(idx, 1);
				}
			}

			if (serialCheckPassed) nftTransfers.push(tfr);
		} else if (tokenType === 'HBAR') {
			tfr.setSerials([0]);
			hbarTransfers.push(tfr);
		} else {
			tfr.setSerials([0]);
			ftTransfers.push(tfr);
		}
	}

	// Check sufficient balances
	let enoughTokens = true;
	for (const [tokenId, requiredAmt] of tokenQtyMap.entries()) {
		const ownedAmt = ownedTokenMap.get(tokenId) || 0;
		const status = requiredAmt <= ownedAmt ? 'PASSED' : '**FAILED**';
		log('INFO', `${tokenId} -> Sending ${requiredAmt} / Owned ${ownedAmt} -> ${status}`, config);

		if (requiredAmt > ownedAmt && !config.isApproval) {
			enoughTokens = false;
		}
	}

	if (!enoughTokens && !config.isApproval) {
		log('ERROR', 'Insufficient tokens to complete airdrop', config);
		exit(1);
	}

	// Allocate random serials for NFTs
	log('INFO', 'Allocating random serials where needed...', config);
	for (const tfr of nftTransfers) {
		const serialArr = tfr.serialArray;
		for (let i = 0; i < serialArr.length; i++) {
			if (serialArr[i] === 0) {
				const serialsAvailable = serialsOwnedMap.get(tfr.tokenId);
				const serial = serialsAvailable.pop();
				serialArr[i] = serial;
			}
		}
	}

	return [nftTransfers, ftTransfers, hbarTransfers, skipped, tokenDecimalsMap];
}

/**
 * Split large NFT transfers into batches of 10 serials each (Hedera limit)
 * @param {Transaction[]} nftTransfers - NFT transfers to split
 * @returns {Transaction[]} - Batched transfers
 */
function splitNftTransfersIntoBatches(nftTransfers) {
	const NFT_BATCH_SIZE = 10;
	const batched = [];

	for (const tfr of nftTransfers) {
		if (tfr.serialArray.length <= NFT_BATCH_SIZE) {
			batched.push(tfr);
		} else {
			// Split into multiple transactions
			for (let i = 0; i < tfr.serialArray.length; i += NFT_BATCH_SIZE) {
				const batchSerials = tfr.serialArray.slice(i, i + NFT_BATCH_SIZE);
				const batchTfr = new Transaction(
					tfr.receiverWallet,
					tfr.tokenId,
					batchSerials.length,
					batchSerials
				);
				batchTfr.originalTransferSize = tfr.serialArray.length; // Track original size
				batchTfr.batchNumber = Math.floor(i / NFT_BATCH_SIZE) + 1;
				batchTfr.totalBatches = Math.ceil(tfr.serialArray.length / NFT_BATCH_SIZE);
				batched.push(batchTfr);
			}
		}
	}

	return batched;
}

/**
 * Execute a single transfer transaction
 * @param {Transaction} tfr - Transfer to execute
 * @param {Client} client - Hedera client
 * @param {PrivateKey} privateKey - Private key
 * @param {Config} config - Configuration
 * @param {Map} tokenDecimalsMap - Token decimals map
 * @returns {Promise<boolean>} - Success status
 */
async function executeSingleTransfer(tfr, client, privateKey, config, tokenDecimalsMap) {
	try {
		const tokenId = tfr.tokenId.toLowerCase();

		if (tokenId === 'hbar') {
			// HBAR transfer
			const tokenTransferTx = new TransferTransaction();
			tokenTransferTx.addHbarTransfer(tfr.receiverWallet, new Hbar(tfr.quantity, HbarUnit.Hbar));

			if (config.isApproval) {
				tokenTransferTx
					.addApprovedHbarTransfer(config.approvalAcct, new Hbar(-tfr.quantity, HbarUnit.Hbar))
					.setTransactionId(TransactionId.generate(config.senderAccountId));
			} else {
				tokenTransferTx.addHbarTransfer(config.senderAccountId, new Hbar(-tfr.quantity, HbarUnit.Hbar));
			}

			tokenTransferTx.setTransactionMemo(config.memo).freezeWith(client);
			const signedTx = await tokenTransferTx.sign(privateKey);
			const txSubmit = await signedTx.execute(client);
			tfr.txId = txSubmit.transactionId.toString();
			const receipt = await txSubmit.getReceipt(client);

			tfr.success = receipt.status.toString() === 'SUCCESS';
			tfr.message = tfr.success ? 'Completed' : `Failed: ${receipt.status.toString()}`;

			return tfr.success;
		} else if (tfr.serialArray.length > 0 && tfr.serialArray[0] !== 0) {
			// NFT transfer (already batched to max 10 serials)
			const tokenTransferTx = new TransferTransaction();

			for (const serial of tfr.serialArray) {
				tokenTransferTx.addNftTransfer(tokenId, serial, config.senderAccountId, tfr.receiverWallet);
			}

			tokenTransferTx.setTransactionMemo(config.memo).freezeWith(client);
			const signedTx = await tokenTransferTx.sign(privateKey);
			const txSubmit = await signedTx.execute(client);
			tfr.txId = txSubmit.transactionId.toString();
			const receipt = await txSubmit.getReceipt(client);

			tfr.success = receipt.status.toString() === 'SUCCESS';

			if (tfr.success) {
				const batchInfo = tfr.totalBatches > 1
					? ` (batch ${tfr.batchNumber}/${tfr.totalBatches})`
					: '';
				tfr.message = `Completed${batchInfo}`;
			} else {
				tfr.message = `Failed: ${receipt.status.toString()}`;
			}

			return tfr.success;
		} else {
			// Fungible token transfer
			const tokenTransferTx = new TransferTransaction();
			const decimals = tokenDecimalsMap.get(tokenId) || 0;
			const adjustedQty = tfr.quantity * Math.pow(10, decimals);

			tokenTransferTx.addTokenTransfer(tokenId, tfr.receiverWallet, adjustedQty);

			if (config.isApproval) {
				tokenTransferTx
					.addApprovedTokenTransfer(tokenId, config.approvalAcct, -adjustedQty)
					.setTransactionId(TransactionId.generate(config.senderAccountId));
			} else {
				tokenTransferTx.addTokenTransfer(tokenId, config.senderAccountId, -adjustedQty);
			}

			tokenTransferTx.setTransactionMemo(config.memo).freezeWith(client);
			const signedTx = await tokenTransferTx.sign(privateKey);
			const txSubmit = await signedTx.execute(client);
			tfr.txId = txSubmit.transactionId.toString();
			const receipt = await txSubmit.getReceipt(client);

			tfr.success = receipt.status.toString() === 'SUCCESS';
			tfr.message = tfr.success ? 'Completed' : `Failed: ${receipt.status.toString()}`;

			return tfr.success;
		}
	} catch (err) {
		tfr.success = false;
		tfr.message = `Error: ${err.message}`;
		return false;
	}
}

/**
 * Process transfers with concurrency control
 * @param {Transaction[]} transfers - All transfers
 * @param {Map} tokenDecimalsMap - Token decimals map
 * @param {Config} config - Configuration
 * @param {boolean} testMode - Test mode flag
 * @returns {Promise<[Transaction[], Transaction[]]>} - [completed, failed]
 */
async function processTransfersParallel(transfers, tokenDecimalsMap, config, testMode) {
	if (testMode) {
		log('INFO', 'TEST MODE: Skipping actual transfers', config);
		return [[], []];
	}

	log('INFO', `Processing ${transfers.length} transfers with max ${config.maxConcurrentTxs} concurrent`, config);

	const myPrivateKey = PrivateKey.fromString(config.privateKey);
	const client = config.network === 'mainnet'
		? Client.forMainnet()
		: config.network === 'testnet'
			? Client.forTestnet()
			: config.network === 'previewnet'
				? Client.forPreviewnet()
				: Client.forNetwork({});

	client.setOperator(config.senderAccountId, myPrivateKey);

	const completed = [];
	const failed = [];
	let totalProcessed = 0;
	let totalSuccess = 0;
	let totalFailed = 0;

	// Process in batches with concurrency limit
	for (let i = 0; i < transfers.length; i += config.maxConcurrentTxs) {
		const batch = transfers.slice(i, i + config.maxConcurrentTxs);

		const promises = batch.map(tfr =>
			executeSingleTransfer(tfr, client, myPrivateKey, config, tokenDecimalsMap)
		);

		const results = await Promise.allSettled(promises);

		for (let j = 0; j < batch.length; j++) {
			const tfr = batch[j];
			const result = results[j];

			if (result.status === 'fulfilled' && tfr.success) {
				completed.push(tfr);
				totalSuccess++;
			} else {
				// If the prior attempt actually reached consensus (e.g. the client
				// timed out fetching the receipt), don't blind-resubmit — that collides
				// (e.g. SENDER_DOES_NOT_OWN_NFT_SERIAL_NO on the retry).
				const priorResult = tfr.retryCount === 0 ? await getTxResultFromMirror(tfr.txId, config) : null;
				if (priorResult === 'SUCCESS') {
					tfr.success = true;
					tfr.message = 'Completed (confirmed via mirror node after receipt timeout)';
					log('INFO', `Transfer to ${tfr.receiverWallet} already succeeded on-chain (${tfr.txId}); skipping retry`, config);
					completed.push(tfr);
					totalSuccess++;
				} else if (tfr.retryCount === 0) {
					tfr.retryCount++;
					log('WARN', `Retrying failed transfer to ${tfr.receiverWallet}`, config);

					await sleep(1000);
					const retrySuccess = await executeSingleTransfer(tfr, client, myPrivateKey, config, tokenDecimalsMap);

					if (retrySuccess) {
						completed.push(tfr);
						totalSuccess++;
					} else {
						failed.push(tfr);
						totalFailed++;
					}
				} else {
					failed.push(tfr);
					totalFailed++;
				}
			}

			totalProcessed++;
			const progressMsg = `Processed: ${totalProcessed}/${transfers.length} | Success: ${totalSuccess} | Failed: ${totalFailed}`;
			showProgress(totalProcessed, transfers.length, progressMsg);
		}

		// Rate limiting: brief pause between batches
		if (i + config.maxConcurrentTxs < transfers.length) {
			await sleep(100);
		}
	}

	client.close();
	log('INFO', `\nFinal Results: ${totalSuccess} succeeded, ${totalFailed} failed out of ${transfers.length} total`, config);
	return [completed, failed];
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Shuffle array in place
 * @param {Array} arr - Array to shuffle
 * @returns {Array}
 */
function shuffleArray(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/**
 * Sleep for ms
 * @param {number} ms - Milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get CLI argument value
 * @param {string} arg - Argument name
 * @returns {string|undefined}
 */
function getArg(arg) {
	const idx = process.argv.indexOf(`-${arg}`);
	return idx > -1 ? process.argv[idx + 1] : undefined;
}

/**
 * Check if CLI flag is present
 * @param {string} arg - Argument name
 * @returns {boolean}
 */
function getArgFlag(arg) {
	return process.argv.indexOf(`-${arg}`) > -1;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log('╔════════════════════════════════════════════════════════════╗');
	console.log('║      Hedera Token Airdrop Script v1.0.0                   ║');
	console.log('╚════════════════════════════════════════════════════════════╝\n');

	if (getArgFlag('h') || getArgFlag('help')) {
		console.log('Usage: node tokenAirdrop.js <file> [options]');
		console.log('\nArguments:');
		console.log('  <file>             CSV file with airdrop data (required)');
		console.log('\nOptions:');
		console.log('  -test              Validate without sending transactions');
		console.log('  -validate          Alias for -test');
		console.log('  -resume            Resume from checkpoint if available');
		console.log('  -approval <id>     Use allowance from account <id>');
		console.log('  -v                 Verbose logging');
		console.log('  -h, -help          Show this help message');
		console.log('\nExamples:');
		console.log('  node tokenAirdrop.js my-airdrop.csv');
		console.log('  node tokenAirdrop.js my-airdrop.csv -test');
		console.log('  node tokenAirdrop.js my-airdrop.csv -resume');
		console.log('\nLegacy format (still supported):');
		console.log('  node tokenAirdrop.js -process my-airdrop.csv');
		console.log('\nSee README.md for detailed documentation.');
		return;
	}

	// Get file from first positional argument or legacy -process flag
	let processFile = process.argv[2];

	// Skip if it's a flag
	if (processFile && processFile.startsWith('-')) {
		processFile = getArg('process');
	}

	if (!processFile) {
		console.error('ERROR: Must specify a CSV file');
		console.log('\nUsage: node tokenAirdrop.js <file> [options]');
		console.log('Run with -h for help');
		return;
	}

	const testMode = getArgFlag('test') || getArgFlag('validate');
	const resumeMode = getArgFlag('resume');

	try {
		const config = buildConfig();

		log('INFO', `Network: ${config.network}`, config);
		log('INFO', `Mirror Node: ${config.mirrorNodeUrl}`, config);
		log('INFO', `Sender: ${config.senderAccountId}`, config);
		log('INFO', `Memo: ${config.memo}`, config);
		log('INFO', `Max Transfer Per Wallet: ${config.maxTransferPerWallet || 'unlimited'}`, config);
		log('INFO', `Max Concurrent Txs: ${config.maxConcurrentTxs}`, config);

		if (config.excludeWallets.length > 0) {
			log('INFO', `Excluded Wallets: ${config.excludeWallets.join(', ')}`, config);
		}
		if (config.excludeSerials.length > 0) {
			log('INFO', `Excluded Serials: ${config.excludeSerials.length} serials`, config);
		}

		let transfers, skipped, tokenBalancesMaps;
		let completedFromCheckpoint = [];

		// Check for checkpoint
		if (resumeMode) {
			const checkpoint = loadCheckpoint(processFile);
			if (checkpoint) {
				log('INFO', `Resuming from checkpoint (${checkpoint.completed.length} completed, ${checkpoint.pending.length} pending)`, config);
				[completedFromCheckpoint, transfers] = restoreFromCheckpoint(checkpoint);

				// Need to rebuild tokenBalancesMaps
				tokenBalancesMaps = new Map();
				const uniqueTokens = new Set(transfers.map(t => t.tokenId.toLowerCase()));
				for (const tokenId of uniqueTokens) {
					if (tokenId !== 'hbar') {
						const balMap = await getTokenBalanceMap(tokenId, config);
						tokenBalancesMaps.set(tokenId, balMap);
					}
				}
				skipped = [];
			} else {
				log('WARN', 'No checkpoint found, starting fresh', config);
				[transfers, skipped, tokenBalancesMaps] = await readAirdropFile(processFile, config);
			}
		} else {
			[transfers, skipped, tokenBalancesMaps] = await readAirdropFile(processFile, config);
		}

		if (transfers.length === 0) {
			log('WARN', 'No transfers to process', config);
			return;
		}

		// Validate and prepare
		const [nftTransfers, ftTransfers, hbarTransfers, validationSkipped, tokenDecimalsMap] =
			await validateAndPrepareTransfers(transfers, tokenBalancesMaps, config);

		skipped.push(...validationSkipped);

		// Split large NFT transfers into batches of 10 (Hedera transaction limit)
		const batchedNftTransfers = splitNftTransfersIntoBatches(nftTransfers);

		if (batchedNftTransfers.length > nftTransfers.length) {
			log('INFO', `Split ${nftTransfers.length} NFT transfers into ${batchedNftTransfers.length} transaction batches`, config);
		}

		const allTransfers = [...batchedNftTransfers, ...ftTransfers, ...hbarTransfers];

		if (testMode) {
			console.log('\n' + '='.repeat(60));
			console.log('TEST MODE - Summary:');
			console.log('='.repeat(60));
			console.log(`NFT Transfers:      ${nftTransfers.length}`);
			console.log(`Fungible Transfers: ${ftTransfers.length}`);
			console.log(`HBAR Transfers:     ${hbarTransfers.length}`);
			console.log(`Skipped:            ${skipped.length}`);
			console.log(`Total to Process:   ${allTransfers.length}`);
			console.log('='.repeat(60));
			return;
		}

		// Process transfers
		const [completed, failed] = await processTransfersParallel(allTransfers, tokenDecimalsMap, config, testMode);

		// Combine with checkpoint completions
		const allCompleted = [...completedFromCheckpoint, ...completed];

		// Save checkpoint if there are failures
		if (failed.length > 0) {
			log('WARN', `${failed.length} transfers failed, saving checkpoint`, config);
			saveCheckpoint(processFile, allCompleted, failed);
		} else {
			// Clean up checkpoint on success
			deleteCheckpoint(processFile);
		}

		// Write results
		writeResults(allCompleted, skipped, failed, processFile, config);

		if (failed.length > 0) {
			console.log(`\n⚠ ${failed.length} transfers failed. Run with -resume to retry.`);
		} else {
			console.log('\n✓ All transfers completed successfully!');
		}

	} catch (err) {
		console.error('\n❌ Fatal error:', err.message);
		if (getArgFlag('v')) {
			console.error(err.stack);
		}
		exit(1);
	}
}

main();
