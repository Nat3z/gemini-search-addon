import OGIAddon, { ConfigurationBuilder, type BasicLibraryInfo } from 'ogi-addon';
import { $ } from 'bun';
import { Context, Effect, Layer, pipe } from 'effect';
import { askAuthGeminiCLI } from './lib';

class AddonService extends Context.Tag("AddonService")<AddonService, { addon: OGIAddon, prompt: (query: string) => Effect.Effect<string> }>() { }


const main = Effect.fn('main')(function* () {
  const { addon, prompt } = yield* AddonService;
  let isConnected = false;
  
  addon.on('configure', (config) => config
    .addNumberOption(option =>
      option.setName('max-results').setDisplayName('Max Results').setDescription('The maximum number of results to return').setDefaultValue(10)
    )
    .addBooleanOption(option => 
      option.setName('conversational')
        .setDisplayName('Conversational')
        .setDescription('Allow to store the previous queries and responses of this session to improve speed and personalization of the responses.')
        .setDefaultValue(true)
    )
  );

  addon.on('connect', (event) => 
    Effect.gen(function* () {
      const file = Bun.file('./first-run.txt');
      if (yield* Effect.promise(async () => await file.exists())) {
        isConnected = true;
        return;
      }
      yield* Effect.promise(async () => await event.askForInput(
        'Gemini AI Search',
        'Because this is your first time running the addon, you will need to authenticate with your Google account to the Gemini CLI. On this next step, you will be redirected to Google to authenticate. Afterwards, you will know if it was successful or not.',
        new ConfigurationBuilder()
      ));

      const result = yield* Effect.promise(async () => await askAuthGeminiCLI());
      if (!result) {
        isConnected = false;
        addon.notify({
          id: 'gemini-ai-search',
          type: 'error',
          message: 'Authentication failed',
        });
        event.fail('Authentication failed');
        return;
      }
      isConnected = true;
      yield* Effect.promise(async () => await file.write('true'));
      addon.notify({
        id: 'gemini-ai-search',
        type: 'success',
        message: 'Authenticated with Gemini',
      });
    }).pipe(
      Effect.runFork
    )
  );

  let currentQuery = '';
  let previousQueries: { query: string, response: string }[] = [];

  addon.on('library-search', (query, event) => Effect.gen(function* () {
    currentQuery = query;
    event.defer();
    // wait 2 seconds to see if the query has changed or has been typing to prevent an onslaught of gemini requests
    yield* Effect.promise(async () => await new Promise(resolve => setTimeout(resolve, 2000)));
    if (currentQuery !== query) {
      event.fail('Query changed');
      return;
    }
    if (!isConnected) {
      event.fail('Not connected to Gemini');
      return;
    }

    const result = yield* prompt(`
      <SYSTEM>
        You are a helpful assistant that can search the steam catalog to provide helpful 
        search information for users when looking for video games.
        SEARCH GAME RULES:
          When providing your response from the user's query, 
          solely provide the name of the game you think best fits the description/prompt provided. Split each game with a new line.
          Don't put anything as comments with parentheses or whatever. Just the name.
          If you don't think there's a video game that fits the description/prompt provided, provide "NO_GAMES".
          Only provide ${addon.config.getNumberValue('max-results')} results.

        COMMENT BLOCK RULES:
          If you want to put a sort of comment about everything, put it in <COMMENT>...</COMMENT>. 
          If you want to put a comment about the game, do {GAME NAME} <COMMENT>...</COMMENT> in the same line of the game.
          If you have a lot to say about the game or are answering a question, make the comment it's own line in the <COMMENT>...</COMMENT> block.
      </SYSTEM>
      <CONTEXT>
        ${previousQueries.map((query) => `
          <QUERY>
            ${query.query}
          </QUERY>
          <RESPONSE>
            ${query.response}
          </RESPONSE>`).join('\n')}
      </CONTEXT>
      <USER>
        ${query}
      </USER>`);

      // if the query has changed, resolve the event with an empty array
      if (currentQuery !== query) {
        event.fail('Query changed');
        return;
      }

      addon.notify({
        id: 'gemini-ai-search',
        type: 'info',
        message: 'Received response from Gemini. Loading results...',
      });
      const results = result.split('\n');
      console.log('Results', results);
      const gamesFound: Awaited<ReturnType<typeof addon.searchGame>> = [];

      let currentComment = '';
      let isInMultiLineComment = false;
      
      for (const result of results) {
        const trimmedResult = result.trim();
        
        // Handle multi-line comments
        if (trimmedResult.startsWith('<COMMENT>') && !trimmedResult.includes('</COMMENT>')) {
          // Start of multi-line comment
          isInMultiLineComment = true;
          currentComment = trimmedResult.replace('<COMMENT>', '').trim() + '\n';
          continue;
        }
        
        if (isInMultiLineComment) {
          if (trimmedResult.includes('</COMMENT>')) {
            // End of multi-line comment
            currentComment += ' ' + trimmedResult.replace('</COMMENT>', '').trim() + '\n';
            isInMultiLineComment = false;
            
            // Add the complete comment as a search result
            for (const line of currentComment.split('\n')) {
              gamesFound.push({
                name: line.trim(),
                appID: 0,
                capsuleImage: '',
                  storefront: 'ai-search'
              } as BasicLibraryInfo);
            }

            
            currentComment = '';
            continue;
          } else {
            // Middle of multi-line comment
            currentComment += ' ' + trimmedResult + '\n';
            continue;
          }
        }
        
        // Handle single-line comments
        if (trimmedResult.startsWith('<COMMENT>') && trimmedResult.includes('</COMMENT>')) {
          gamesFound.push({
            name: trimmedResult.replace('<COMMENT>', '').replace('</COMMENT>', '').trim(),
            appID: 0,
            capsuleImage: '',
            storefront: 'ai-search'
          } as BasicLibraryInfo);
          continue;
        }
        
        // Handle game names with inline comments
        const gameName = trimmedResult.replace(/<COMMENT>.*?<\/COMMENT>/g, '').trim();
        const comment = trimmedResult.match(/<COMMENT>(.*?)<\/COMMENT>/)?.[1] || '';
        
        // Skip empty game names
        if (!gameName) {
          continue;
        }
        
        const game = yield* Effect.promise(async () => await addon.searchGame(gameName, 'steam'));
        if (game.length === 0) {
          continue;
        }

        // match exact name
        const exactMatch = game.find((game) => game.name.toLowerCase() === gameName.toLowerCase());
        if (exactMatch) {
          gamesFound.push({
            name: exactMatch.name + (comment ? ` (${comment})` : ''),
            appID: exactMatch.appID,
            capsuleImage: exactMatch.capsuleImage,
            storefront: exactMatch.storefront
          });
          continue;
        }
      }

      // if the user allowed conversational mode, store the query and response
      if (addon.config.getBooleanValue('conversational')) {
        previousQueries.push({ query, response: result });
      }
      event.resolve(gamesFound);
  }).pipe(
    Effect.runFork
  ));

  addon.on('disconnect', () => {
    process.exit(0);
  });
})

Effect.runSync(pipe(
  main(),
  Effect.provideService(AddonService, {
    addon: new OGIAddon({
      name: 'Gemini AI Search',
      version: '1.0.0',
      id: 'gemini-ai-search',

      author: 'Nat3z',
      description: 'A Gemini AI Search addon for OpenGameInstaller',
      repository: 'https://github.com/Nat3z/gemini-search-addon',
      storefronts: [],
    }),
    prompt: (query) => Effect.gen(function* () {
      const result = yield* Effect.promise(async () => await $`bunx @google/gemini-cli -m "gemini-2.5-flash" -p "${query}"`.text());
      
      return result;
    }),
  })
));