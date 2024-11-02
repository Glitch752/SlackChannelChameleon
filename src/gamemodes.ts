enum GameMode {
    /**
     * A game mode where every player is assigned a word or phrase to describe to the other players without saying the word or phrase itself.  
     * When a player guesses your word or phrase, both you and the player who guessed correctly are given points.
     */
    Charades
}

type PlayerData = {
    score: number;
};

type SaveData = {
    players: {
        [playerID: string]: PlayerData
    }
};

let saveData: SaveData = loadSaveData();

function loadSaveData() {
    return {
        players: {}
    };
}