import * as fsPromises from "fs/promises";
import exitHook from "async-exit-hook";

export enum GameMode {
    /**
     * A game mode where every player is assigned a word or phrase to describe to the other players without saying the word or phrase itself.  
     * When a player guesses your word or phrase, both you and the player who guessed correctly are given points.
     */
    Charades
};

// There's probably a better way to do this, but this works for now.

type SerializedPlayerData = {
    scoreAllTime: number;
    scoreDays: {
        [day: string]: number
    }
};
type SerializedSaveData = {
    players: { [playerID: string]: SerializedPlayerData }
};

enum ScorePeriod {
    AllTime,
    Today,
    PastWeek
};

/**
 * A player's data, including their score.
 */
class PlayerData {
    private scoreAllTime: number;
    private scoreDays: {
        /** The day, in days since the Unix epoch. */
        [day: number]: number
    };

    /**
     * Loads player data from a serialized format.
     * @param data
     */
    public constructor(data: SerializedPlayerData | null = null) {
        if(data === null) {
            this.scoreAllTime = 0;
            this.scoreDays = {};
        } else {
            this.scoreAllTime = data.scoreAllTime;
            this.scoreDays = data.scoreDays;
        }
    }

    /**
     * Gets the current day, in days since the Unix epoch.
     * @returns
     */
    private today() {
        return Math.floor(Date.now() / 1000 / 60 / 60 / 24);
    }

    /**
     * Adds points to the player's score.
     */
    public addPoints(points: number) {
        this.scoreAllTime += points;
        const today = this.today();
        this.scoreDays[today] = (this.scoreDays[today] ?? 0) + points;
    }

    /**
     * Gets the player's score for the specified period.
     * @param period 
     * @returns 
     */
    public score(period: ScorePeriod): number {
        switch(period) {
            case ScorePeriod.AllTime:
                return this.scoreAllTime;
            case ScorePeriod.Today:
                return this.scoreDays[this.today()];
            case ScorePeriod.PastWeek:
                const today = this.today();
                let score = 0;
                for(let i = 0; i < 7; i++) {
                    score += this.scoreDays[today - i] ?? 0;
                }
                return score;
            default:
                const _exhaustiveCheck: never = period;
                return _exhaustiveCheck;
        }
    }

    /**
     * Serializes the player data to a format that can be saved to a file.
     * @returns
     */
    public serialize(): SerializedPlayerData {
        return {
            scoreAllTime: this.scoreAllTime,
            scoreDays: this.scoreDays
        };
    }
};

/**
 * The save data for the game. Currently only includes player data.
 */
class SaveData {
    /** The player data. */
    private players: {
        [playerID: string]: PlayerData
    };

    /**
     * Creates a new SaveData object and loads the save data from the provided file if it exists.
     * @param saveFile 
     */
    public constructor(saveFile: string) {
        this.players = {};
        this.loadFromFile(saveFile);

        // Attatch a listener to process exit to save the data before the program closes
        exitHook(async (callback) => {
            await this.saveToFile(saveFile);
            callback();
        });
        
        // Automatically save the data every 5 minutes
        setInterval(() => this.saveToFile(saveFile), 1000 * 60 * 5);
    }

    /**
     * Writes the game's save data to a file.
     * @param path
     */
    private async saveToFile(path: string) {
        console.log("\x1b[33m", "Saving game data...", "\x1b[0m");
        const data: SerializedSaveData = {
            players: Object.fromEntries(
                Object.entries(this.players).map(([playerID, playerData]) => [playerID, playerData.serialize()])
            )
        };
        await fsPromises.writeFile(path, JSON.stringify(data));
        console.log("\x1b[32m", "Game data saved!", "\x1b[0m");
    }

    /**
     * Loads the game's save data from a file.
     * @param path
     * @returns
     */
    private async loadFromFile(path: string) {
        // If the save data file doesn't exist, create it
        try {
            await fsPromises.access(path);
        } catch {
            const defaultSaveData: SerializedSaveData = { players: {} };
            await fsPromises.writeFile(path, JSON.stringify(defaultSaveData));
        }
    
        try {
            const data: SerializedSaveData = JSON.parse(await fsPromises.readFile(path, "utf-8"));
            this.players = Object.fromEntries(
                Object.entries(data.players).map(([playerID, playerData]) => [playerID, new PlayerData(playerData)])
            );
            console.log("\x1b[32m", "Game data loaded!", "\x1b[0m");
        } catch {
            console.error("Failed to load save data. Creating new save data.");
            // Back up the old save data if it exists
            try {
                await fsPromises.copyFile(path, `${path}.bak`);
            } catch {
                console.error("Failed to back up save data.");
            }
    
            return {
                players: {}
            };
        }
    }

    /**
     * Gets the leaderboard for a specified period.
     * @param period
     * @param topPlayers 
     * @returns 
     */
    public getLeaderboard(period: ScorePeriod, topPlayers: number = 10): string {
        const sortedPlayers = Object.entries(this.players).sort((a, b) => b[1].score(period) - a[1].score(period));
        const topPlayersData = sortedPlayers.slice(0, topPlayers);
        if(topPlayersData.length === 0) {
            return "No players found.";
        }

        const scorePeriodNames: { [period in ScorePeriod]: string } = {
            [ScorePeriod.AllTime]: "all time",
            [ScorePeriod.Today]: "today",
            [ScorePeriod.PastWeek]: "the past week"
        };
        let leaderboard = `Top ${topPlayersData.length} players for ${scorePeriodNames[period]}:  \n`;
        leaderboard += topPlayersData.map(([playerID, playerData], index) => `${index + 1}. <@${playerID}>: ${playerData.score(period)}`).join("  \n");
        return leaderboard;
    }

    /**
     * Adds points to a player's score.
     */
    public addPoints(playerID: string, points: number) {
        if(this.players[playerID] === undefined) {
            this.players[playerID] = new PlayerData();
        }
        this.players[playerID].addPoints(points);
    }
};

// No DB needed for now... JSON is enough for this small project
const saveDataPath = "saveData.json";
let saveData: SaveData = new SaveData(saveDataPath);
let gameMode: GameMode = GameMode.Charades;

export function startGame(mode: GameMode) {
    gameMode = mode;
    console.log("\x1b[33m", `Game mode set to ${GameMode[mode]}!`, "\x1b[0m");
}