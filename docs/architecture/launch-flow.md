# Launch flow

Verified order:
1. `create_v2`
2. ATA/setup
3. `create_fee_sharing_config`
4. `update_fee_shares_v2(9000/1000)`
5. `buy_v2`

Split-before-buy is mandatory because buy-before-shares leaves an unsafe fee window.
