# tokenAirdrop

Designed to read in a file for processing

**instructions for running towards the bottom**

file format (headers):
## destWallet,tokenToSend,quantity,serial

serial is only needed when the token being sent is an NFT and can be ommited when snding FUNGIBLE_COMMON tokens

serial=0 implies send a random NFT owned (excluding any serials in the .env file EXCLUDE_SERIALS variable [a comma seperated list or a range **NEVER BOTH**])

for example
0.0.XXXX,0.0.YYYYY,1,0  -> send any random NFT owned
0.0.XXXX,0.0.YYYYY,1,3  -> send user serial 3 (if owned else error message / skip)
0.0.XXXX,0.0.ZZZZZ,1	-> send user 1 FC token

**ASSUMPTIONS**
The sending account is treasury account (or there are no royalties - specifically a fall back fee) so there is no need for the receiving party to sign.

If sending Fungible Common tokens that all instructions for a given token will be grouped together for efficiency. Will still work if seperated but may end up with more transactions than optimal thus slower.

**Script will**:
 * read in the file
 * check the quantity to send is not more than MAX_TRANSFER tokens [quantity will be adjusted down (floor 0) if possible] -- check across lines (dupes)
 * check the token type [NFT/FC]
 * check the destination address has the token associated
 * upon validation of the line store the pending transaction
 * continue until input file processed
 * check sender has enough tokens to honour the request
 * spit out human form the of the transaction to process (then exit is in -test mode)
 * batch the transactions to process [dealing with NFT and FC tokens seperately]

-------

**setup your.env file [sending wallet / PK / any limit on sending / memo ]**

node tokenAirdrop.js -process <filename>
  -> send out the airdrop 

node tokenAirdrop.js -process <filename> -test
  -> run the process without sending any tokens.

**in more narrative format**

you will need a .env file - can create or rename .env.example - i recommend the following settings (replacing your account/key of course 

ENVIRONMENT=MAIN
MY_ACCOUNT_ID=0.0.222
MY_PRIVATE_KEY=302asbbdskbfjhfskhkds
MAX_TRANSFER=
MEMO='Airdrop'
EXCLUDE_WALLETS=
EXCLUDE_SERIALS=


then create a file to drive the airdrop - call it whatever you like (you do not need the header but included for easier reference):
## destWallet,tokenToSend,quantity,serial
0.0.1111,0.0.1042640,5,*****
0.0.11111,0.0.1042695,5,*****
0.0.111111,0.0.1042726,1,0


replace *'s with a comma separated list of serials e.g. 1,3,6,10,15 (enough to match the quantity) or a 0 and it will pick them randomly.

then you can run from terminal:

node tokenAirdrop.js -process <filename> -test

filename being the name of the above instruction file you saved