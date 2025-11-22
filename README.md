# Hedera Token Airdrop Script v1.0.0

A powerful, production-ready tool for distributing tokens (NFTs, Fungible Tokens, and HBAR) on the Hedera network with parallel processing, automatic retry, and resume capability.

## ✨ Features

- 🚀 **Parallel Processing** - Send up to 50 transactions concurrently for fast airdrops
- 🔄 **Auto-Retry & Resume** - Automatic retry on failures with checkpoint system for resuming interrupted runs
- 📊 **Progress Tracking** - Real-time progress bar shows airdrop status
- 💎 **Multi-Token Support** - Handle NFTs, Fungible Tokens, and HBAR in one airdrop
- ✅ **Pre-Flight Validation** - Validates balances, associations, and serials before sending
- 📝 **Dual Output** - Human-readable CSV + machine-readable JSON output
- 🌐 **Network Flexibility** - Supports mainnet, testnet, previewnet, and custom networks
- 🔐 **Allowance Support** - Can spend from approved allowances

## 📋 Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CSV File Format](#csv-file-format)
- [Usage Examples](#usage-examples)
- [Command Line Options](#command-line-options)
- [Output Files](#output-files)
- [Advanced Features](#advanced-features)
- [Troubleshooting](#troubleshooting)

## 🚀 Installation

### Prerequisites

- Node.js 16+ installed
- A Hedera account with tokens/NFTs/HBAR to distribute
- Private key for the sender account

### Setup Steps

1. **Clone or download this repository**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure your environment**
   
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your details (see [Configuration](#configuration))

4. **Create your airdrop file**
   
   Use `example-airdrop.csv` as a template or create your own

5. **Run a test**
   ```bash
   node tokenAirdrop.js -process your-airdrop.csv -test
   ```

## ⚙️ Configuration

Edit your `.env` file with the following settings:

### Network Configuration

```env
# Network: mainnet, testnet, previewnet, or custom
NETWORK=mainnet

# Only needed if NETWORK=custom
CUSTOM_MIRROR_URL=
```

### Account Configuration

```env
# Your Hedera account ID
MY_ACCOUNT_ID=0.0.123456

# Your private key (keep this secret!)
MY_PRIVATE_KEY=302e020100300506032b657004220420...
```

### Transfer Limits

```env
# Maximum tokens any single wallet can receive (optional)
# Leave empty for no limit
MAX_TRANSFER=

# Maximum concurrent transactions (default: 50)
# Adjust if you hit rate limits
MAX_CONCURRENT_TXS=50
```

### Transaction Settings

```env
# Memo for all transactions
MEMO=Airdrop

# Wallets to exclude from airdrop (comma-separated)
EXCLUDE_WALLETS=0.0.111,0.0.222

# NFT serials to never send (comma-separated OR range)
# Examples: 1,2,3,4,5  OR  1-100
EXCLUDE_SERIALS=
```

## 📄 CSV File Format

Your airdrop file should be a CSV with the following format:

```csv
# Lines starting with # are comments and will be ignored
# Format: destWallet,tokenToSend,quantity,serial(s)

# Send NFTs with specific serials
0.0.1234567,0.0.9876543,5,100,101,102,103,104

# Send random NFTs (use 0 for serial)
0.0.2345678,0.0.9876543,1,0

# Send fungible tokens (no serial needed)
0.0.3456789,0.0.8765432,100

# Send HBAR (use 'hbar' as token ID)
0.0.4567890,hbar,2.5
```

### Field Descriptions

| Field | Description | Required | Example |
|-------|-------------|----------|---------|
| **destWallet** | Recipient Hedera account ID | Yes | `0.0.1234567` |
| **tokenToSend** | Token ID or `hbar` for HBAR | Yes | `0.0.9876543` or `hbar` |
| **quantity** | Amount to send | Yes | `10` or `2.5` |
| **serial(s)** | NFT serial number(s) or `0` for random | For NFTs | `123` or `0` |

### Rules & Tips

- ✅ **Comments**: Lines starting with `#` are ignored
- ✅ **Empty lines**: Blank lines are ignored
- ✅ **NFT Serials**: 
  - Provide specific serials: `100,101,102` (must match quantity)
  - Use `0` to randomly select from your owned NFTs
- ✅ **Fungible Tokens**: Omit serial field or use `0`
- ✅ **HBAR**: Use `hbar` as the token ID (case insensitive)
- ✅ **Decimals**: Automatically handled based on token configuration
- ⚠️ **Association Required**: Recipients must have associated the token first

## 🎯 Usage Examples

### Basic Airdrop

Send tokens to recipients:
```bash
node tokenAirdrop.js -process my-airdrop.csv
```

### Test Mode (Validation Only)

Validate your airdrop file without sending anything:
```bash
node tokenAirdrop.js -process my-airdrop.csv -test
```

### Resume Failed Airdrop

If your airdrop was interrupted or had failures, resume from checkpoint:
```bash
node tokenAirdrop.js -process my-airdrop.csv -resume
```

### Using Allowance

Send tokens from an approved allowance:
```bash
node tokenAirdrop.js -process my-airdrop.csv -approval 0.0.999999
```

### Verbose Mode

Enable detailed logging for debugging:
```bash
node tokenAirdrop.js -process my-airdrop.csv -v
```

## 🎛️ Command Line Options

| Option | Description | Example |
|--------|-------------|---------|
| `-process <file>` | **Required.** CSV file with airdrop data | `-process airdrop.csv` |
| `-test` | Validate without sending transactions | `-test` |
| `-validate` | Alias for `-test` | `-validate` |
| `-resume` | Resume from checkpoint (for failed runs) | `-resume` |
| `-approval <id>` | Use allowance from specified account | `-approval 0.0.123456` |
| `-v` | Enable verbose logging | `-v` |
| `-h` or `-help` | Show help message | `-h` |

## 📤 Output Files

After running an airdrop, you'll get two output files:

### 1. CSV Output (Human-Readable)

**Filename**: `output_<inputfile>_<timestamp>.csv`

```csv
# Airdrop Results - 2025-11-22T10:30:45.123Z
# Status,Destination,Token,Quantity,Serials,Message,TransactionID
SUCCESS,0.0.1234567,0.0.9876543,5,100,101,102,103,104,Completed,0.0.123456@1732272645.123456789
FAILED,0.0.2345678,0.0.8765432,10,0,Error: INSUFFICIENT_TOKEN_BALANCE,
SKIPPED,0.0.3456789,0.0.7654321,1,0,NOT ASSOCIATED: **SKIPPED**,
```

### 2. JSON Output (Machine-Readable)

**Filename**: `output_<inputfile>_<timestamp>.json`

```json
{
  "timestamp": "2025-11-22T10:30:45.123Z",
  "summary": {
    "total": 100,
    "completed": 95,
    "failed": 2,
    "skipped": 3
  },
  "transactions": {
    "completed": [ /* array of completed transactions */ ],
    "failed": [ /* array of failed transactions */ ],
    "skipped": [ /* array of skipped transactions */ ]
  }
}
```

### Status Meanings

- **SUCCESS**: Transaction completed successfully
- **FAILED**: Transaction was attempted but failed (includes error message)
- **SKIPPED**: Transaction was not attempted due to validation failure

## 🔧 Advanced Features

### Checkpoint & Resume System

The script automatically creates checkpoint files (`.checkpoint_*`) during processing. These allow you to resume if:
- The script crashes
- Network issues occur
- Transactions fail

**To resume**: Simply run with `-resume` flag
```bash
node tokenAirdrop.js -process my-airdrop.csv -resume
```

The checkpoint stores:
- ✅ All completed transactions
- ⏸️ All pending transactions
- 🔄 Retry counts

### Automatic Retry

Failed transactions are automatically retried once with:
- 1-second delay between attempts
- Exponential backoff for network calls
- Detailed error messages for debugging

### Parallel Processing

Transactions are sent in parallel batches (default: 50 concurrent) to maximize throughput while respecting network limits.

**Adjust concurrency** in `.env`:
```env
MAX_CONCURRENT_TXS=50
```

### Random NFT Selection

When you specify serial `0` for NFTs, the script will:
1. Fetch all NFTs you own for that token
2. Exclude any serials in `EXCLUDE_SERIALS`
3. Randomly shuffle remaining serials
4. Allocate them to recipients

This ensures fair distribution and prevents duplicate sends.

### Token Association Checking

Before processing, the script:
1. Checks if recipients have associated the token
2. Skips transfers to non-associated wallets
3. Provides clear feedback on which transfers were skipped

## 🐛 Troubleshooting

### Common Issues

**Problem**: `INVALID_ACCOUNT_ID` error
- **Solution**: Check that wallet addresses in CSV start with `0.0.` and are valid

**Problem**: `INSUFFICIENT_TOKEN_BALANCE` error
- **Solution**: Verify you own enough tokens/NFTs to complete the airdrop

**Problem**: Token not associated errors
- **Solution**: Recipients must associate tokens before receiving them

**Problem**: Rate limit errors
- **Solution**: Reduce `MAX_CONCURRENT_TXS` in `.env` (try 25 or 10)

**Problem**: Script crashes mid-airdrop
- **Solution**: Run with `-resume` to continue from checkpoint

### Verbose Mode

For detailed debugging information:
```bash
node tokenAirdrop.js -process my-airdrop.csv -v
```

This shows:
- Mirror node API calls
- Token balance queries
- Serial allocation details
- Detailed error stack traces

### Getting Help

1. Check the CSV file format matches examples
2. Verify `.env` configuration is correct
3. Run in `-test` mode first to validate
4. Enable `-v` for verbose logging
5. Check the output JSON for detailed error messages

## 📊 Performance Tips

- **Group similar tokens** in your CSV for efficiency
- **Use appropriate concurrency** - default (50) works well for most cases
- **Test first** with `-test` to catch issues early
- **Monitor progress** - the progress bar shows real-time status
- **Resume on failure** - don't restart from scratch, use `-resume`

## 🔐 Security Notes

- ⚠️ **Never commit `.env` file** - it contains your private key
- ⚠️ **Keep private keys secure** - treat them like passwords
- ⚠️ **Test on testnet first** - use `NETWORK=testnet` for testing
- ⚠️ **Review CSV carefully** - double-check recipients and amounts

## 📝 License

ISC License - see package.json for details

## 👤 Author

Stowerling

---

**Version**: 1.0.0  
**Last Updated**: November 2025

For issues or questions, please review the troubleshooting section or check your CSV format and `.env` configuration.