#!/usr/bin/env node

const minimist = require('minimist');
const chalk = require('chalk');
const axios = require('axios');
const util = require('util');
const url = require('url');
const querystring = require('querystring');
const path = require('path');
const fs = require('fs').promises;
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const sleep = util.promisify(setTimeout);
const packageFile = require('./package.json');

const getOneYearAgoIso = () => {
  const date = new Date();
  const thisYear = date.getFullYear();
  const lastYear = thisYear - 1;
  date.setFullYear(lastYear);
  return date.toISOString();
};

const defaultApiUrl = 'https://api.10000ft.com/api/v1/';
const entriesPerChunk = 100;
const defaultStartIsoDate = getOneYearAgoIso();
const defaultTicketPattern = '[A-Z]+-\\d+';
const defaultFileName = '10kticketstat.csv';

const isoTo10KDate = (isoDateString) => {
  const date = new Date(isoDateString);
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
};

const parse10KResponseHeader = (responseHeader) => responseHeader
  .replace(/[{}:]/g, '')
  .split(', ')
  .map((keyValueString) => keyValueString.split('=>'))
  .reduce((accumulator, [key, value]) => {
    const numberValue = Number(value);
    accumulator[key] = Number.isNaN(numberValue) ? value : numberValue;
    return accumulator;
  }, {});

const getTimeEntries = async ({
  projectId,
  apiKey,
  apiUrl,
  startIsoDate,
  endIsoDate,
  page = '1',
  entryAccumulator = [],
}) => {
  const requestPath = `projects/${projectId}/time_entries`;
  const requestUrl = `${apiUrl}${apiUrl.endsWith('/') ? '' : '/'}${requestPath}`;
  const from = startIsoDate ? isoTo10KDate(startIsoDate) : undefined;
  const to = endIsoDate ? isoTo10KDate(endIsoDate) : undefined;

  const config = {
    headers: {
      auth: apiKey,
    },
    params: {
      from,
      to,
      page,
      per_page: entriesPerChunk,
    },
  };

  let nextPage;
  let accumulatedEntries;

  try {
    const response = await axios.get(requestUrl, config);
    const { data: { paging, data: timeEntries } } = response;
    accumulatedEntries = entryAccumulator.concat(timeEntries);

    console.log(`Downloaded data chunk #${paging.page} from 10K.`);

    // Done. Return all the concatenated pages.
    if (!paging.next) {
      return accumulatedEntries;
    }

    const rateInfo = parse10KResponseHeader(response.headers['x-ratelimit-data']);
    // I may be misinterpreting this header. Hopefully the response
    // time request will add sufficient wiggle room.
    const minimumRequestIntervalMs = (rateInfo.period * 1000) / rateInfo.limit;
    await sleep(minimumRequestIntervalMs);

    const { query: nextPageQuery } = url.parse(paging.next);
    nextPage = querystring.parse(nextPageQuery).page;
  } catch (error) {
    if (!error.response || error.response.status !== 429) {
      throw error;
    }

    // We exceeded the rate limit. This should not happen if I've read
    // the x-ratelimit-data header correctly, but it's here just in
    // case.
    const resetUnixTime = Number(error.response.headers['X-RateLimit-Reset']);
    const nowUnixTime = Date.now();
    const msToReset = resetUnixTime - nowUnixTime;
    await sleep(msToReset);
    nextPage = page;
    accumulatedEntries = entryAccumulator;
  }

  // Tail call self with parameters set to retry if rate limit
  // exceeded.
  return getTimeEntries({
    projectId,
    apiKey,
    apiUrl,
    startIsoDate,
    endIsoDate,
    page: nextPage,
    entryAccumulator: accumulatedEntries,
  });
};

const saveStatisticsAsCsv = async (statistics, outputPath) => {
  const csvWriter = createCsvWriter({
    path: outputPath,
    header: [
      { id: 'ticket', title: 'Ticket' },
      { id: 'hours', title: 'Hours' },
    ],
  });

  await csvWriter.writeRecords(statistics);
};

const analyzeTimeEntries = (timeEntries, ticketPattern) => {
  const ticketRegExp = new RegExp(ticketPattern, 'g');

  const timeEntryReducer = (entryStatAccumulator, timeEntry) => {
    const { hours } = timeEntry;
    const notes = timeEntry.notes || '';
    const ticketsMatchedInEntry = notes.match(ticketRegExp) || [];
    ticketsMatchedInEntry.forEach((ticket) => {
      const existingTicketStat = entryStatAccumulator.find(
        (entryStat) => entryStat.ticket === ticket,
      );

      if (existingTicketStat) {
        existingTicketStat.hours += hours;
      } else {
        entryStatAccumulator.push({
          ticket,
          hours,
        });
      }
    });
    return entryStatAccumulator;
  };

  return timeEntries.reduce(timeEntryReducer, []);
};

const resolveOutputPath = async (userOutputPath) => {
  try {
    const userPathStat = await fs.stat(userOutputPath);
    const isDirectory = userPathStat.isDirectory();
    return isDirectory
      ? path.join(userOutputPath, defaultFileName)
      : userOutputPath;
  } catch (error) {
    // Assume that the error is a result of trying to run stat on a
    // file that doesn't exist yet. If this assumption is false, we can
    // safely assume another error will be thrown when attempting to
    // write to userOutputPath.
    return userOutputPath;
  }
};

const run = async () => {
  const requiredArgNames = [
    'projectId',
    'outputPath',
    'apiKey',
  ];

  const optionalArgNames = [
    'api-url',
    'start-iso-date',
    'end-iso-date',
    'ticket-pattern',
  ];

  const argv = minimist(process.argv.slice(2));

  if (argv.v || argv.version) {
    console.log(packageFile.version);
    return;
  }

  if (argv.h || argv.help || argv._.length !== requiredArgNames.length) {
    const optionals = optionalArgNames.map((name) => `[--${name}]`);
    const requireds = requiredArgNames.map((name) => chalk.underline(name));
    console.log();
    console.log(`usage: 10kticketstat ${requireds.join(' ')}`);
    console.log(`       ${optionals.join(' ')}\n`);
    return;
  }

  const requiredArgsObj = requiredArgNames.reduce((accumulator, name, index) => {
    accumulator[name] = argv._[index];
    return accumulator;
  }, {});

  try {
    const timeEntries = await getTimeEntries({
      projectId: requiredArgsObj.projectId,
      apiKey: requiredArgsObj.apiKey,
      apiUrl: argv['api-url'] || defaultApiUrl,
      startIsoDate: argv['start-iso-date'] || defaultStartIsoDate,
      endIsoDate: argv['end-iso-date'],
    });

    console.log('Download complete.');

    const statistics = analyzeTimeEntries(
      timeEntries,
      argv['ticket-pattern'] || defaultTicketPattern,
    );

    const outputPath = await resolveOutputPath(requiredArgsObj.outputPath);
    await saveStatisticsAsCsv(statistics, outputPath);
    console.log(`Done. Analysis saved to: ${outputPath}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

run();
