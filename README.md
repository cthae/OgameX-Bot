# OgameX-Bot

Tampermonkey JS bot to automate basic routines for OgameX!

<img width="413" height="1001" alt="image" src="https://github.com/user-attachments/assets/c427f63f-1f79-4639-90eb-76a293893472" />


# Basic features

* **Asteroid Miner**: Periodically checks if there are asteroids available, then checks the ranges and dispatches asteroid miners.
* **Inactives Farmer**: Farms inactives. Can farm with BCs. Made with the Inactive Farming Event in mind.
* **Defense**: Monitors for attacks, saves the fleet when one is detected.
* **Fleet Save**: Grabs the res and all ships, fly to another moon on deployment mission. Recall in the middle, as usual.
* **Expeditions**: Sends expos from a moon whenever there are slots.
* **Bonus**: Grabs the green DM + Academy points bonus.
* **Anti detection**: a primitive attempt to randomize certain actions. Minor but better than nothing.

# How to use

1. This bot works through a tampermonkey Chrome extension. [Install tampermonkey from Chrome webstoer](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=en), then click [this link](https://github.com/cthae/OgameX-Bot/raw/refs/heads/main/ogamex-bot.user.js) to install the script.
2. Open Ogamex and you will see the bot panel on the left.
3. Select which features you want to enable and configure them. Hovering over features shows brief description.
4. Enjoy the automation

# Contributions

Contributions to this repo are very welcome. I'm mostly trying to automate the basic funcitons to not get distracted by the game. It consumes too much time without a bot.

# Plan

* [ ] Add an auto-recycler worker to pick up expo debriss quickly. It disappears in an hour.
* [ ] Add some Merchant -> Auction gentle logic. Not too competitive to avoid detection. Maybe make a bid every 10 minutes or so if the price is allowing.
* [ ] Add the Merchant -> Export/Import automation.
* [ ] Polish the logic manually where needed.
* [ ] Test main features [in progress]
  * [ ] Fleet Save: pending testing.
  * [ ] Defense automation has bugs. Probably something to do with Polish regexes not translating perfectly back to English. I haven't yet looked closer into it.
  * [x] Inactives Farmer works well. It's simplistic and designed to only farm one system range from one origin at a time. Which is good enough for the inactive farming event. Not as good for casual farming. It's far less elaborate than Tbot's autofarmer, but it does the trick fine.
  * [x] Anti detection seem to be working fine. It's not diablable though.
  * [x] Expos are being sent properly though there are slight quirks. It sends them manually one after another to avoid them all coming back together to prevent a timed destruction of all fleets. But it doesn't collect debriss, which is the main point of expos later on. 
  * [x] Asteroids are being correctly scanned and mined on time.
  * [x] Online Bonus is being automatically claimed whenever it's there.
* [x] Translate the bot.

# Contact

For now, I'm just gonna risk using [Tbot's Discord server](https://discord.gg/At6kMEsck) for chatting since I find it cozy and losely related, but if they mind us there, I'll move it to somewhere else.

# History

Someone used Claude to generate a bot for OgameX and made it publically available here: https://github.com/Mitjano/ogamex-userscript/blob/main/ogamex-bot.user.js
The huge issue with that repo is that it's in Polish... Readme is Egnlish, but almost the whole codebase is in Polish. Iiiincluding regexes used to check for messages from ogamex. Which is... Uh. Terrible.

I cloned it at version 2.99.1 and ran it through DeepSeek trying to translate it to English. DeepSeek didn't like the task and got looped in writing subprompts to itself. Had to stop it after half an hour and make it stop trying to translate regular expressions and var names, etc. It managed to recover and finish the task in a minute after that. Initial testing shows that the bot works.

# Disclaimer

Given how this was all vibe coded, it is risky to run. Don't run on accounts you treasure. I have more fun tinkering with scripts than playing the actual game, so I don't worry about getting banned. So far, however, I haven't been banned, so there's no automatic detection in place to act upon. OgameX devs are also busy with their new game, so I don't expect any sophisticated analysis done on this script to detect it reliably. The whole bot loop runs in a closure, so nothing is exposed. Seemingly. I haven't yet gone through the whole codebase. AI can make odd decisions.

Berware, however, that you will be banned if you invoke enough reasonable suspicion. So like if you play for 90 hours straight with no pause, that's sus. Do use the sleep feature or let the bot chill manually by just closing the tab. I usually let it chill for 8 hours every 50 hours or so.

The bot kinda tries to use a few third party but so far what I'm seeing is these are benign things. 
