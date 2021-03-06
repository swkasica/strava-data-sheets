//
// Main.gs
// =================================================================================
//

// Global Variables
// ---------------------------------------------------------------------------------
//
var SCRIPT_PROPS = PropertiesService.getScriptProperties();
var SPREADSHEET = SpreadsheetApp.openById(SCRIPT_PROPS.getProperty('SHEET_ID'));
var CLIENT_ID = SCRIPT_PROPS.getProperty('STRAVA_CLIENT_ID');
var CLIENT_SECRET = SCRIPT_PROPS.getProperty('STRAVA_CLIENT_SECRET');
var PREV_YEAR_TAB = 'Previous Year';
var DATA_VARIABLES = ['CreatedAt', 'ActivityType', 'DistanceMeters', 'ElapsedTimeInSeconds', 
                  'MovingTimeInSeconds', 'MovingDuration', 'TotalElevationGain', 
                  'ActivityID', 'WeekStart', 'WeekEnd', 'WorkoutType'];

// Main functions
// ---------------------------------------------------------------------------------
// These are high-level actions and the functions called by Triggers

function createPreviousYearSheet() {
  // Create a brand new sheet for storing Strava activity data from the previous 12-months
  //
  var sheetName = PREV_YEAR_TAB;
  var columns = DATA_VARIABLES;
  var columnWidth = 200;  // in pixels
  var popFunc = 'updatePrevYearSheet_';

  var sheet = SPREADSHEET.getSheetByName(sheetName);
  if (!sheet) {    
    // Create and format sheet
    var sheet = SPREADSHEET.insertSheet();    
    sheet.setName(sheetName)
         .setColumnWidths(1, columns.length, columnWidth)
    sheet.deleteColumns(columns.length + 1, sheet.getMaxColumns() - columns.length);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, columns.length)
         .setValues([DATA_VARIABLES])
         .setFontWeight("bold")
         .setBackground('#6495ED')  // Cornflower blue
         .setFontColor('#ffffff');  // White

    // Set trigger
    var triggers = ScriptApp.getProjectTriggers().filter(function(trig) {
      return (trig.getHandlerFunction() === popFunc);
    });
    
    if (triggers.length) {
      throw new Error('A trigger for ' + popFunc + ' already exists. Delete this trigger first.');
    } else {
      // set trigger
      ScriptApp.newTrigger(popFunc)
        .timeBased()
        .atHour(0)
        .nearMinute(0)
        .everyDays(1)
        .create();
    }

    // Populate newly created sheet
    getLastYearActivities_(sheetName);
    

  } else {
    throw new Error(sheetName + ' already exists');
  }
}

function updatePrevYearSheet_() {
  // Append activities that happened after yesterday at mightnight to a
  // spreadsheet tab. Use this function in a time-based trigger.
  var yesterday = new Date().incDate(-1);
  yesterday.setHours(0, 0, 0);  // Set time to yesterday at precisely midnight
  return appendActivities_(yesterday, PREV_YEAR_TAB);
  
  pruneOldRecords_(PREV_YEAR_TAB);
}

function clearSheet_() {
  // Removes all data, excluding the sheet header, from the PREV_YEAR_TAB.
  
  var sheet = SPREADSHEET.getSheetByName(PREV_YEAR_TAB);
  var rowPosition = 2;  // Rows are one-indexed, they start at "1"
  var howMany = sheet.getLastRow() - 1;
  sheet.deleteRows(rowPosition, howMany);
}

function getLastYearActivities_(sheet) {
  // Populates an entire sheet with data straight from the Strava Activities API with
  // activities after the date specified in the variable `startDate`.
  //
  // Params:
  //   * sheet {Sheet} the instance of the Sheet class to populate
  //
  
  var now = new Date();
  var startDate = new Date(now.setFullYear(now.getFullYear() - 1));
  
  return appendActivities_(startDate, sheet);
}

function appendActivities_(startDate, sheet) {
  // Make a request to the Strava API's athlete activity list endpoint 
  // and append each of those activities as rows in the spreadsheet.

  var resultsPerPage = 100;
  var sheet = SPREADSHEET.getSheetByName(sheet);
  var i = 0;
  var res, body;
  do {
    i++;
    res = Strava.getActivitiesList({
      after: startDate.toEpoch(),
      page: i,
      per_page: resultsPerPage,
    });
    body = JSON.parse(res.getContentText());
    body.map(function(obj) {
      // Subset activity object data and export as array
      return new Activity_(obj).toRow();
    }).forEach(function(row) {
      // Add "new" data to the appropriate sheet    
      sheet.appendRow(row);    
    });
  } while (body.length !== 0);
  
  return null;
  
}

function pruneOldRecords_(sheetName) {
  // Remove records from the `PREV_YEAR_TAB` sheet older than one year.
  //
  // @TODO: sort sheet before performing this procedure. For correctness, this 
  // algorithm currently assumes that rows are ordered sequentially in ascending 
  // order by creation date. So if you sort the sheet it's not going to work. 
  
  var sheet = SPREADSHEET.getSheetByName(sheetName);

  // Set a threshold that's the beginning of the week for one year ago today
  var threshold = new Date().minusYears(1).getWeekStart();
  
  // Set a row offset to start removing rows from, Data rows start at rows 2
  var rowOffset = 2;
  
  // Create a boolean vector of whether or not this 
  var oldRows = sheet.getRange('A2:A')
                      .getValues()
                      .filter(function(createdAt) { 
                        return (new Date(createdAt) < threshold); 
                      });
  
  // Now remove rows that are too old, stopping when the loop reaches 
  // the first one within the time window
  if (oldRows.length > 0) {
    sheet.deleteRows(rowOffset, oldRows.length);  
  }
    
  return null;
  
}

function resolveActivityFragments() {
  // Combine multiple activities that are actually one activity. 
  //
  // Note: I often save an activity when I change shoes for a workout
  // This function will combine multiple Strava activites that were
  // saved close together into one row in the spreadsheet.
  
  var sheetName = PREV_YEAR_TAB;
  var threshold = 3.6e+6 // 60 minutes in milliseconds
  var offset = 2;
  var sheet = SPREADSHEET.getSheetByName(sheetName);
  
  var rows = sheet.getRange('A2:K').getValues();
  var rowsDeleted = 0;
  
  findDupes(sheet.getRange('A2:B').getValues(), 3.6e+6).forEach(function(dupes) {
    dupes = dupes.map(function(dupe) { return dupe - offset; });  // Numbers are now indices into rows array
    var parentAct = new Activity_(rows[dupes[0]]);
    var childAct;
    
    for (var i = 1; i < dupes.length; i++) {
      childAct = new Activity_(rows[dupes[i]]);
      if (childAct.properties[childAct.columns[10]] !== 'Race') {
        parentAct.merge(childAct);
      }
    }
    
    // Overwrite the first row's value as the combine values in parent activity
    var rowNumber = dupes[0] + offset - rowsDeleted;
    var rowRange = 'A' + rowNumber + ':K' + rowNumber;
    sheet.getRange(rowRange).setValues([parentAct.toRow()]);
    
    // Remove the rows that are now merged in the parent row
    var rowsToDelete = dupes.length - 1
    sheet.deleteRows(rowNumber + 1, rowsToDelete);
    rowsDeleted += rowsToDelete;

  });
  
  return null;
  
  function findDupes(rows, threshold) {
    var mergeList = [];
    var cluster = [];
    for (var i = 0; i < rows.length - 1; i++) {
      var cur = rows[i];
      var nxt = rows[i + 1];
      var isBelowThreshold = ((new Date(nxt[0]) - new Date(cur[0])) < threshold)
      var isWithinActivity = (cur[1] === nxt[1]);
      
      if (isBelowThreshold && isWithinActivity) {  // if this is a duplicate pair of row
        if (cluster.length === 0) {  // if this is the first duplicate pair, add both
          cluster = cluster.concat([i + offset, i + offset + 1]);
        } else {  // cluster has already started so curr's row number is in the array, add the next item's row number
          cluster.push(i + offset + 1);
        }
      } else if (cluster.length > 0) {  // We are at the end of a sequence of duplicates
        mergeList.push(cluster);
        cluster = [];  // reset cluster
      }
    }
    
    return mergeList;
    
  }
  
}

// Functions for establishing a connection to Strava 
// ----------------------------------------------------
//

function establishStravaConnection() {
  // Initliazes Strava connection, only need to be run once
  Strava.authorize();
}

function resetStravaConnection() {
  Strava.service.reset();
}

function authCallback_(request) {
  // Handles the OAuth callback
  var authorized = Strava.service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput('Success!');
  } else {
    return HtmlService.createHtmlOutput('Denied.');
  }
}