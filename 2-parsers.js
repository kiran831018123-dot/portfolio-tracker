function openExcelImportModal(targetType) {
      const titles = {
        mf: 'Import Mutual Funds (Excel / CSV / PDF)',
        nps: 'Import NPS Statement (Yearly CSVs or Holding PDF)',
        retiral: 'Import EPF & PPF (PDF / CSV / Excel)'
      };
      const hints = {
        mf: 'Expected columns: <strong>Scheme Name</strong> (or Fund Name), <strong>Units</strong>, <strong>Invested</strong>, and optional <em>Scheme Code</em>, <em>NAV</em>, <em>Category</em>, <em>SIP</em>.',
        nps: 'Upload <strong>multiple yearly Transaction Statement CSVs</strong> at once OR your <strong>Holding Statement PDF</strong> from Protean/KFintech. (If PDF is password-protected, enter your PRAN/password below first.)',
        retiral: 'Expected columns: <strong>Type</strong> (EPF or PPF), <strong>Balance</strong>, <strong>Invested</strong> (or Principal), and optional <em>Monthly</em>.'
      };
      const templates = {
        mf: 'Scheme Name,Scheme Code,Category,Units,Invested,NAV,SIP\nUTI Nifty 50 Index Fund - Direct Growth,120716,Index,100.5,15000,162.45,5000\n',
        nps: 'Scheme Name,Tier,Units,Invested,NAV,Monthly\nHDFC Pension Fund - Scheme E,Tier I,500.0,20000,48.92,5000\n',
        retiral: 'Type,Balance,Invested,Monthly\nEPF,485000,410000,12500\nPPF,315000,270000,5000\n'
      };

      openModal(titles[targetType], `
        <div class="space-y-3 text-xs">
          <p class="text-slate-300 leading-relaxed">${hints[targetType]}</p>
          <input id="excelFileInput" type="file" multiple class="w-full text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-emerald-600 file:text-white hover:file:bg-emerald-500" />
          <input id="pdfPasswordInput" type="password" placeholder="Optional: PDF Password (e.g. PRAN or DOB if importing encrypted PDF)" class="w-full px-3 py-1.5 rounded-xl bg-surface-800 border border-slate-700 text-white text-xs focus:outline-none focus:border-amber-500" />
          <div class="pt-1 border-t border-slate-800">
            <label class="block text-slate-400 mb-1">Or paste rows copied from Excel / Google Sheets:</label>
            <textarea id="excelPasteInput" rows="3" placeholder="Paste table rows (including header row) here..." class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white focus:outline-none focus:border-emerald-500"></textarea>
            <button id="btnParsePaste" type="button" class="mt-1.5 px-3 py-1.5 rounded-lg bg-surface-700 hover:bg-surface-600 text-slate-200 font-semibold">Read Pasted Rows</button>
          </div>
          <div id="excelPreviewBox" class="hidden rounded-xl bg-surface-800 border border-slate-700 p-3 text-slate-200"></div>
          <pre id="excelDebugLog" class="hidden rounded-xl bg-black/50 border border-slate-800 p-2.5 text-[10px] text-slate-400 whitespace-pre-wrap max-h-28 overflow-y-auto"></pre>
          <div class="flex gap-2 pt-1">
            <button id="btnDownloadTemplate" type="button" class="flex-1 py-2 rounded-xl bg-surface-800 hover:bg-surface-700 border border-slate-700 text-slate-200 font-semibold">Sample CSV</button>
            <button id="btnConfirmImport" type="button" disabled class="flex-1 py-2 rounded-xl bg-emerald-600 disabled:opacity-40 text-white font-bold">Import Rows</button>
          </div>
        </div>
      `);

      let parsedRows = [];

      document.getElementById('btnDownloadTemplate').addEventListener('click', () => {
        const blob = new Blob([templates[targetType]], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wealthlocal-${targetType}-template.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });

      // Zero preloaded user folios or amounts — 100% parsed dynamically from the uploaded file
      const KNOWN_FOLIOS = {};
      const KNOWN_UNITS = [];

      function normalizeNpsDate(rawDt) {
        const s = String(rawDt || '').trim();
        const expandYr = (y) => y.length === 2 ? (parseInt(y, 10) >= 70 ? '19' + y : '20' + y) : y;
        // Convert DD-MM-YYYY or DD-MM-YY or DD/MM/YYYY or DD-Mon-YY / DD-Mon-YYYY to YYYY-MM-DD
        const mNum = s.match(/^(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2}|\d{4})$/);
        if (mNum) {
          return `${expandYr(mNum[3])}-${mNum[2].padStart(2, '0')}-${mNum[1].padStart(2, '0')}`;
        }
        const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
        const mMon = s.match(/^(\d{1,2})[\-\/\s]([A-Za-z]{3})[a-z]*[\-\/\s](\d{2}|\d{4})$/i);
        if (mMon && months[mMon[2].toLowerCase()]) {
          return `${expandYr(mMon[3])}-${months[mMon[2].toLowerCase()]}-${mMon[1].padStart(2, '0')}`;
        }
        return s;
      }

      function detectStatementDateFromGridEnhanced(grid) {
        const months = {
          jan:'01', january:'01', feb:'02', february:'02', mar:'03', march:'03',
          apr:'04', april:'04', may:'05', jun:'06', june:'06', jul:'07', july:'07',
          aug:'08', august:'08', sep:'09', september:'09', oct:'10', october:'10',
          nov:'11', november:'11', dec:'12', december:'12'
        };
        for (let r = 0; r < Math.min(grid.length, 35); r++) {
          if (!Array.isArray(grid[r])) continue;
          const line = grid[r].map(c => String(c || '')).join(' ');
          const mIso = line.match(/(?:AS ON|DATE)[:\s\-]*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
          if (mIso) return mIso[1];
          // e.g. "as on November 13, 2026"
          const mWord = line.match(/as\s+on\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(20\d{2})/i);
          if (mWord && months[mWord[1].toLowerCase()]) {
            return `${mWord[3]}-${months[mWord[1].toLowerCase()]}-${mWord[2].padStart(2, '0')}`;
          }
          // e.g. "as on 12-Nov-2026" or "12-11-2026"
          const mDmy = line.match(/as\s+on\s+(\d{1,2}[\-\/](?:[A-Za-z]{3}|\d{1,2})[\-\/]20\d{2})/i);
          if (mDmy) return normalizeNpsDate(mDmy[1]);
        }
        return '';
      }

      function extractEpfPassbookFromGrid(grid) {
        const out = [];
        for (let r = 0; r < grid.length; r++) {
          const row = grid[r];
          if (!Array.isArray(row)) continue;
          const nonEmpty = row.map(c => String(c == null ? '' : c).trim()).filter(Boolean);
          if (nonEmpty.length === 0) continue;
          const joined = nonEmpty.join(' ');

          // Skip Opening Balance ("OB Int. Updated upto...") and Closing Balance and Total summary lines
          if (/^OB\s+Int\.|Closing\s+Balance\s+as\s+on|Total\s+Contributions\s+for|Total\s+Transfer-Ins|Total\s+Withdrawals/i.test(joined)) {
            continue;
          }

          // 1. Annual Interest Credited Row: "Int. Updated upto 31/03/2019   157   48   0" (not starting with OB)
          const intMatch = joined.match(/^(?!OB\b).*?Int\.?\s*Updated\s*upto\s*(\d{2}[\-\/]\d{2}[\-\/]\d{4})/i)
                        || joined.match(/Interest\s+updated\s+upto\s*(\d{2}[\-\/]\d{2}[\-\/]\d{4})/i);
          if (intMatch) {
            const intDate = normalizeNpsDate(intMatch[1]);
            // Extract trailing numbers after the date string
            const afterDate = joined.slice(joined.indexOf(intMatch[1]) + intMatch[1].length);
            const nums = (afterDate.match(/\b\d[\d,]*\b/g) || []).map(x => cleanNum(x));
            if (nums.length >= 2) {
              const empInt = nums[0] || 0;
              const emprInt = nums[1] || 0;
              const penInt = nums[2] || 0;
              if (empInt + emprInt > 0) {
                out.push({
                  _epfType: 'interest',
                  date: intDate,
                  fyLabel: `FY ending ${intDate}`,
                  empInterest: empInt,
                  emprInterest: emprInt,
                  pensionInterest: penInt
                });
              }
            }
            continue;
          }

          // 2. Monthly Contribution Row: e.g. "Sep-2018  01-10-2018  CR  Cont. for Due-Month 102018  6,884  6,884  826  253  573"
          const wageMonthM = joined.match(/\b([A-Za-z]{3}-20\d{2})\b/);
          const txDateM = joined.match(/\b(\d{2}-\d{2}-20\d{2})\b/);
          const isContRow = /Cont\.?\s*for\s*Due-Month|By\s+Transfer|Transfer-In/i.test(joined) || (wageMonthM && txDateM && /\bCR\b/.test(joined));
          if (isContRow && (txDateM || wageMonthM)) {
            const txDate = txDateM ? normalizeNpsDate(txDateM[1]) : normalizeNpsDate('01-' + wageMonthM[1]);
            const wageMonth = wageMonthM ? wageMonthM[1] : txDate.slice(0, 7);
            // Find the position after "Due-Month YYYYMM" or after "CR" to read the 5 numbers: [EPF Wages, EPS Wages, Employee Share, Employer Share, Pension Share]
            let tailText = joined;
            const dueM = joined.match(/Due-Month\s*\d+/i);
            if (dueM) {
              tailText = joined.slice(joined.indexOf(dueM[0]) + dueM[0].length);
            } else if (txDateM) {
              tailText = joined.slice(joined.indexOf(txDateM[1]) + txDateM[1].length);
            }
            const nums = (tailText.match(/\b\d[\d,]*\b/g) || []).map(x => cleanNum(x));
            if (nums.length >= 3) {
              // Standard 5-number EPFO layout: [epfWage, epsWage, empShare, emprShare, pensionShare]
              let epfWage = 0, empShare = 0, emprShare = 0, pensionShare = 0;
              if (nums.length >= 5) {
                epfWage = nums[0];
                empShare = nums[2];
                emprShare = nums[3];
                pensionShare = nums[4];
              } else if (nums.length === 4) {
                epfWage = nums[0];
                empShare = nums[1];
                emprShare = nums[2];
                pensionShare = nums[3];
              } else {
                empShare = nums[0];
                emprShare = nums[1];
                pensionShare = nums[2] || 0;
              }
              if (empShare + emprShare > 0) {
                out.push({
                  _epfType: 'contribution',
                  wageMonth: wageMonth,
                  date: txDate,
                  epfWage: epfWage,
                  empShare: empShare,
                  emprShare: emprShare,
                  pensionShare: pensionShare
                });
              }
            }
            continue;
          }

          // 3. PPF Statement Row: e.g. "15-Dec-2021  25788077  PPF Account-PPF00QU0000044  500  0  500"
          // or "31-Mar-2022  29187540  PPF interest Paid  887  0  50887"
          const ppfDateM = joined.match(/^(\d{1,2}-[A-Za-z]{3}-20\d{2}|\d{1,2}[\-\/]\d{1,2}[\-\/]20\d{2})\b/);
          if (ppfDateM && !/\bDue-Month\b/i.test(joined) && !/statement|period|from\s+\d|printed|generated/i.test(joined)) {
            const txDate = normalizeNpsDate(ppfDateM[1]);
            // Look BOTH 2 lines above and 2 lines below in case wrapped PDF cell text ("PPF interest" / "Paid") was placed above/below the row baseline
            let contextText = joined;
            for (const offset of [-2, -1, 1, 2]) {
              const adj = grid[r + offset];
              if (!Array.isArray(adj)) continue;
              const adjLine = adj.join(' ');
              if (!/\b(\d{1,2}-[A-Za-z]{3}-20\d{2}|\d{1,2}[\-\/]\d{1,2}[\-\/]20\d{2})\b/.test(adjLine)) {
                contextText += ' ' + adjLine;
              }
            }
            const afterDt = joined.slice(joined.indexOf(ppfDateM[1]) + ppfDateM[1].length);
            const rawTokens = afterDt.match(/\b\d+(?:,\d+)*(?:\.\d+)?\b/g) || [];
            // A real PPF table row MUST have a 7–10 digit Transaction ID + Credit + Debit + Balance (at least 4 numeric tokens)
            if (rawTokens.length >= 4 && rawTokens[0].length >= 7 && !rawTokens[0].includes(',')) {
              const txId = rawTokens[0];
              const numTokens = rawTokens.slice(1).map(x => cleanNum(x));
              const creditAmt = numTokens[0] || 0;
              const debitAmt = numTokens[1] || 0;
              const runningBal = numTokens[2] || numTokens[numTokens.length - 1] || 0;
              // Detect annual PPF interest: either wrapped text has "interest" OR date is 31-Mar (`-03-31`) where bank credits annual interest
              const isMarch31Interest = txDate.endsWith('-03-31') && !/subscription|omnichannel/i.test(joined);
              const isInterest = /interest|int\.?\s*paid/i.test(contextText) || isMarch31Interest;
              const desc = isInterest
                ? 'PPF Interest Paid'
                : (/subscription/i.test(contextText) ? 'PPF Subscription' : (/omnichannel/i.test(contextText) ? 'Payment through omnichannel' : (/ppf\s*account/i.test(contextText) ? 'PPF Account Opening' : 'PPF Deposit')));

              if (creditAmt > 0 && runningBal >= creditAmt) {
                out.push({
                  _ppfType: isInterest ? 'interest' : 'deposit',
                  txId: txId,
                  date: txDate,
                  desc: desc,
                  credit: creditAmt,
                  debit: debitAmt,
                  balance: runningBal
                });
              }
            }
          }
        }
        return out;
      }

      function extractNpsSpecialFromGrid(grid) {
        const summaryRows = [];
        const txRows = [];
        let mode = 'SCAN'; // 'SCHEME_SUMMARY' | 'CONTRIB_SKIP' | 'TX_SCHEME'
        let activeTxScheme = '';
        let detectedTotalContribution = 0;
        const stmtDate = detectStatementDateFromGridEnhanced(grid);
        if (stmtDate) lastDetectedStatementDate = stmtDate;

        // Scan top 20 rows for Protean Section 0 `Total Contribution in your account` (e.g. Row 12 header -> Row 14 `Rs 105435.00` in Col C)
        for (let r = 0; r < Math.min(grid.length, 20); r++) {
          const row = grid[r];
          if (!Array.isArray(row)) continue;
          for (let c = 0; c < row.length; c++) {
            if (/total\s*contribution\s*in\s*your\s*account/i.test(String(row[c] || ''))) {
              for (let lookR = r + 1; lookR <= Math.min(grid.length - 1, r + 3); lookR++) {
                const candidateCell = grid[lookR] && grid[lookR][c];
                const val = cleanNum(candidateCell);
                if (val >= 500) {
                  detectedTotalContribution = val;
                  break;
                }
              }
            }
          }
        }

        const isSchemeTitle = (txt) => {
          const s = String(txt || '').trim();
          if (s.length < 10 || s.length > 140) return false;
          // Must contain a PFM name or "PENSION FUND" + "SCHEME" or "TIER"
          return /(pension\s+fund|retirement\s+fund)/i.test(s) && /(scheme\s*[\-:]?\s*[ecga]|tier\s*[\-:]?\s*(?:i|ii|1|2)|central\s+govt|state\s+govt|corporate)/i.test(s) && !/^by\s+/i.test(s) && !/uploaded\s+by/i.test(s);
        };

        for (let r = 0; r < grid.length; r++) {
          const row = grid[r];
          if (!Array.isArray(row)) continue;
          const nonEmpty = row.map(c => String(c == null ? '' : c).trim()).filter(Boolean);
          if (nonEmpty.length === 0) continue;
          const joined = nonEmpty.join(' ');
          const firstCell = nonEmpty[0];

          // 1. Detect Section Transitions in Protean / NSDL CRA Statement
          if (/scheme\s*wise\s*summary|investment\s*details\s*[\-–]?\s*scheme/i.test(joined)) {
            mode = 'SCHEME_SUMMARY';
            continue;
          }
          if (/contribution\s*\/\s*redemption\s*details/i.test(joined)) {
            mode = 'CONTRIB_SKIP';
            activeTxScheme = '';
            continue;
          }
          if (/^transaction\s*details$/i.test(firstCell) || /^transaction\s*details/i.test(joined)) {
            mode = 'TX_WAIT_SCHEME';
            activeTxScheme = '';
            continue;
          }

          // 2. Check if this row is a standalone Scheme Section Header (e.g. Row 40: "ADITYA BIRLA SUN LIFE PENSION FUND SCHEME E - TIER I POP")
          if (nonEmpty.length <= 2 && isSchemeTitle(firstCell)) {
            activeTxScheme = firstCell;
            mode = 'TX_SCHEME';
            continue;
          }

          // 3. Inside SCHEME_SUMMARY (Rows 19–21: Col A = Scheme Name, Col B = Scheme-wise Value, Col C = Total Units, Col D = NAV)
          if (isSchemeTitle(firstCell) && nonEmpty.length >= 3) {
            const nums = nonEmpty.slice(1).map(c => cleanNum(c)).filter(n => n > 0);
            if (nums.length >= 2) {
              // Protean CSV order: nums[0] = Value (81214.05), nums[1] = Total Units (2768.3706), nums[2] = NAV (29.3364)
              const val = nums[0];
              const units = nums[1];
              const nav = (nums[2] && nums[2] >= 5 && nums[2] <= 300) ? nums[2] : (units > 0 ? +(val / units).toFixed(4) : 20);
              if (units > 0 && val > 0) {
                summaryRows.push({
                  _rowType: 'summary',
                  'Scheme Name': firstCell,
                  'Total Units': units,
                  'Latest NAV': nav,
                  'Current Value': val,
                  'Statement Date': lastDetectedStatementDate || '',
                  '_totalAccountContribution': detectedTotalContribution
                });
              }
              continue;
            }
          }

          // 4. Inside TX_SCHEME (e.g. Rows 41–55 under "ADITYA BIRLA SUN LIFE PENSION FUND SCHEME E - TIER I POP")
          if (mode === 'TX_SCHEME' && activeTxScheme) {
            const c0 = String(row[0] == null ? '' : row[0]).trim();
            const c1 = String(row[1] == null ? '' : row[1]).trim();
            const c2 = String(row[2] == null ? '' : row[2]).trim();
            const c3 = String(row[3] == null ? '' : row[3]).trim();
            const c4 = String(row[4] == null ? '' : row[4]).trim();

            const dateStr = normalizeNpsDate(c0 || firstCell);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

            // If this is a Closing Balance row, capture its exact Closing Units as a summary fallback if Section 1 wasn't present
            if (/closing\s*balance|balance\s*c\/f/i.test(joined)) {
              const closeUnits = parseFloat((c4 || c3 || c2).replace(/[₹,\s]/g, ''));
              const closeNav = cleanNum(c3);
              if (!isNaN(closeUnits) && closeUnits > 0) {
                const hasSummary = summaryRows.some(s => s['Scheme Name'] === activeTxScheme);
                if (!hasSummary) {
                  summaryRows.push({
                    _rowType: 'summary',
                    'Scheme Name': activeTxScheme,
                    'Total Units': +closeUnits.toFixed(4),
                    'Latest NAV': closeNav > 0 ? closeNav : 25,
                    'Current Value': closeNav > 0 ? +(closeUnits * closeNav).toFixed(2) : 0,
                    'Statement Date': dateStr || lastDetectedStatementDate || ''
                  });
                }
              }
              continue;
            }

            // Capture Opening Balance row (`01-Apr-YYYY | Opening Balance`) so carried-forward units from prior FYs are preserved in the transaction ledger!
            if (/opening\s*balance|balance\s*b\/f/i.test(joined)) {
              const openUnits = parseFloat((c4 || c3 || c2).replace(/[₹,\s]/g, ''));
              const openNav = cleanNum(c3) || 20;
              const openVal = cleanNum(c2) || (openUnits > 0 && openNav > 0 ? +(openUnits * openNav).toFixed(2) : 0);
              if (!isNaN(openUnits) && openUnits > 0) {
                txRows.push({
                  _rowType: 'opening',
                  'Scheme Name': activeTxScheme,
                  'Transaction Date': dateStr,
                  'Description': 'Opening Balance (Brought Forward)',
                  'Contribution Amount': openVal,
                  'NAV': openNav,
                  'Units': +openUnits.toFixed(4)
                });
              }
              continue;
            }

            const rawAmtStr = c2.replace(/[₹,\s]/g, '');
            const parsedAmt = parseFloat(rawAmtStr);
            const nav = cleanNum(c3);
            const rawUnitsStr = c4.replace(/[₹,\s]/g, '');
            const parsedUnits = parseFloat(rawUnitsStr);

            // Exact CSV Units from Column E (c4) always take priority; fallback to amt / nav only if c4 is blank
            const units = (!isNaN(parsedUnits) && parsedUnits !== 0)
              ? +parsedUnits.toFixed(4)
              : (!isNaN(parsedAmt) && nav > 0 ? +(parsedAmt / nav).toFixed(4) : 0);
            const amt = !isNaN(parsedAmt) ? parsedAmt : (nav > 0 && units !== 0 ? +(units * nav).toFixed(2) : 0);

            if (units !== 0 && (nav > 0 || amt !== 0)) {
              txRows.push({
                _rowType: 'tx',
                'Scheme Name': activeTxScheme,
                'Transaction Date': dateStr,
                'Description': c1 || (units < 0 ? 'CRA / Administrative Unit Deduction' : 'NPS Contribution'),
                'Contribution Amount': amt,
                'NAV': nav > 0 ? nav : 25,
                'Units': units
              });
            }
          }
        }
        return [...summaryRows, ...txRows];
      }

      async function parsePdfBufferLocally(u8, password) {
        if (typeof pdfjsLib === 'undefined') {
          throw new Error('PDF parser library not loaded');
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const loadingTask = pdfjsLib.getDocument({ data: u8, password: password || undefined, isEvalSupported: false });
        const pdf = await loadingTask.promise;
        const allLines = [];
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          // Group text items by Y coordinate (within 3pt tolerance) to reconstruct table rows
          const rowMap = [];
          tc.items.forEach(item => {
            const str = String(item.str || '').trim();
            if (!str) return;
            const y = item.transform ? item.transform[5] : 0;
            const x = item.transform ? item.transform[4] : 0;
            let bucket = rowMap.find(b => Math.abs(b.y - y) <= 3.5);
            if (!bucket) {
              bucket = { y, items: [] };
              rowMap.push(bucket);
            }
            bucket.items.push({ x, str });
          });
          rowMap.sort((a, b) => b.y - a.y);
          rowMap.forEach(b => {
            b.items.sort((a, c) => a.x - c.x);
            allLines.push(b.items.map(i => i.str));
          });
        }
        return allLines;
      }

      function parseCsvGridNative(text) {
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() !== '');
        if (lines.length === 0) return [];
        // Detect delimiter: comma, tab, or semicolon
        const sample = lines.slice(0, 15).join('\n');
        const tabCount = (sample.match(/\t/g) || []).length;
        const semiCount = (sample.match(/;/g) || []).length;
        const commaCount = (sample.match(/,/g) || []).length;
        const delim = tabCount > commaCount ? '\t' : (semiCount > commaCount ? ';' : ',');

        return lines.map(line => {
          const out = [];
          let cur = '';
          let inQuotes = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
              else { inQuotes = !inQuotes; }
            } else if (ch === delim && !inQuotes) {
              out.push(cur.trim());
              cur = '';
            } else {
              cur += ch;
            }
          }
          out.push(cur.trim());
          return out;
        });
      }

      function extractRowsFromGrid(grid) {
        const headerKeywords = [
          'scheme name', 'fund name', 'pfm name', 'scheme details', 'scheme',
          'units', 'total units', 'no. of units', 'balance units', 'allotted units',
          'invested value', 'invested', 'total contribution', 'contribution amount', 'amount',
          'current value', 'market value', 'valuation', 'nav', 'balance', 'type'
        ];
        let headerIdx = -1;
        for (let r = 0; r < grid.length; r++) {
          if (!Array.isArray(grid[r])) continue;
          const cells = grid[r].map(c => String(c == null ? '' : c).trim().toLowerCase());
          const hits = headerKeywords.filter(kw => cells.some(c => c === kw || c.includes(kw)));
          if (hits.length >= 2) {
            headerIdx = r;
            break;
          }
        }
        const jsonRows = [];
        if (targetType === 'retiral') {
          const epfRows = extractEpfPassbookFromGrid(grid);
          if (epfRows.length > 0) return epfRows;
        }
        // First try specialized NPS Holding / Transaction row detector (handles multi-section Protean CSVs & PDFs)
        const npsSpecial = extractNpsSpecialFromGrid(grid);
        if (npsSpecial.length > 0 && targetType === 'nps') {
          return npsSpecial;
        }
        if (headerIdx !== -1) {
          const headers = grid[headerIdx].map((h, i) => String(h == null ? '' : h).trim() || `col_${i}`);
          for (let r = headerIdx + 1; r < grid.length; r++) {
            const rowArr = grid[r];
            if (!Array.isArray(rowArr) || rowArr.every(c => String(c == null ? '' : c).trim() === '')) continue;
            const obj = {};
            headers.forEach((h, i) => { obj[h] = rowArr[i] !== undefined ? rowArr[i] : ''; });
            jsonRows.push(obj);
          }
          return jsonRows;
        }
        if (npsSpecial.length > 0) return npsSpecial;
        // Fallback when sharedStrings.xml was placed at the end of a streaming XLSX:
        for (let r = 0; r < grid.length; r++) {
          const rowArr = grid[r];
          if (!Array.isArray(rowArr)) continue;
          const u = cleanNum(rowArr[6]);
          if (u <= 0) continue;
          const folioStr = String(rowArr[4] || '').trim().replace(/\.0+$/, '');
          const knownByFolio = KNOWN_FOLIOS[folioStr];
          const knownByUnits = KNOWN_UNITS.find(k => Math.abs(k.units - u) < 0.01);
          const known = knownByFolio || knownByUnits;

          const rawInv = cleanNum(rowArr[7]);
          const rawCur = cleanNum(rowArr[8]);
          const rawRet = cleanNum(rowArr[9]);
          const inv = rawInv > 0 ? rawInv : (known ? known.invested : 0);
          const cur = rawCur > 0 ? rawCur : (rawInv > 0 && rawRet !== 0 ? rawInv + rawRet : (known ? known.curVal : inv));

          jsonRows.push({
            'Scheme Name': rowArr[0] || (known ? known.name : `Mutual Fund (Folio ${folioStr || (r + 1)})`),
            'Scheme Code': known ? known.code : '000000',
            'Category': rowArr[3] || rowArr[2] || (known ? known.cat : 'Equity'),
            'Folio No.': folioStr || (known ? known.folio : ''),
            'Units': u,
            'Invested Value': inv,
            'Current Value': cur
          });
        }
        return jsonRows;
      }

      let lastDetectedStatementDate = '';
      function detectStatementDateFromGrid(grid) {
        for (let r = 0; r < Math.min(grid.length, 30); r++) {
          if (!Array.isArray(grid[r])) continue;
          for (const cell of grid[r]) {
            const m = String(cell || '').match(/(?:AS ON|DATE)[:\s\-]*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
            if (m) return m[1];
          }
        }
        return new Date().toISOString().slice(0, 10);
      }

      function extractRowsFromWorkbook(wb) {
        let detectedSheet = wb.SheetNames[0];
        let jsonRows = [];
        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          if (!sheet) continue;
          const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          lastDetectedStatementDate = detectStatementDateFromGrid(grid);
          const rows = extractRowsFromGrid(grid);
          if (rows.length > 0) {
            jsonRows = rows;
            detectedSheet = sheetName;
            break;
          }
        }
        if (jsonRows.length === 0 && wb.SheetNames.length > 0) {
          jsonRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        }
        return { detectedSheet, jsonRows };
      }

      async function inflateRawBytes(chunk) {
        if (typeof DecompressionStream === 'undefined') throw new Error('No DecompressionStream');
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        const chunks = [];
        const readPromise = (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) chunks.push(value);
            }
          } catch (e) {}
        })();
        try {
          await writer.write(chunk);
          await writer.close();
        } catch (e) {}
        await readPromise;
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        return new TextDecoder('utf-8').decode(merged);
      }

      function colLettersToIdx(ref) {
        const m = String(ref || '').match(/^([A-Z]+)/i);
        if (!m) return 0;
        let idx = 0;
        const letters = m[1].toUpperCase();
        for (let i = 0; i < letters.length; i++) {
          idx = idx * 26 + (letters.charCodeAt(i) - 64);
        }
        return idx - 1;
      }

      async function parseBrokenXlsxLocally(u8) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const entries = {};
        const headerOffsets = [];
        for (let i = 0; i + 30 < u8.length; i++) {
          if (u8[i] === 0x50 && u8[i + 1] === 0x4B && u8[i + 2] === 0x03 && u8[i + 3] === 0x04) {
            const fnLen = dv.getUint16(i + 26, true);
            if (fnLen > 0 && fnLen < 260 && i + 30 + fnLen <= u8.length) {
              headerOffsets.push(i);
            }
          }
        }
        for (let idx = 0; idx < headerOffsets.length; idx++) {
          const pos = headerOffsets[idx];
          const method = dv.getUint16(pos + 8, true);
          const fnLen = dv.getUint16(pos + 26, true);
          const exLen = dv.getUint16(pos + 28, true);
          const nameStart = pos + 30;
          const dataStart = nameStart + fnLen + exLen;
          const fileName = new TextDecoder('utf-8').decode(u8.subarray(nameStart, nameStart + fnLen));
          const nextPos = idx + 1 < headerOffsets.length ? headerOffsets[idx + 1] : u8.length;
          if (fileName.endsWith('.xml') && dataStart < u8.length) {
            try {
              const xmlStr = method === 0
                ? new TextDecoder('utf-8').decode(u8.subarray(dataStart, nextPos))
                : await inflateRawBytes(u8.subarray(dataStart));
              if (xmlStr) entries[fileName.replace(/^\/+/, '')] = xmlStr;
            } catch (e) {
              addDebugLog(`Inflate err (${fileName}): ${e.message}`);
            }
          }
        }
        addDebugLog('XML entries: ' + (Object.keys(entries).join(', ') || 'none'));
        const shared = [];
        const ssKey = Object.keys(entries).find(k => k.toLowerCase().includes('sharedstrings.xml'));
        if (ssKey) {
          const ssXml = entries[ssKey];
          const siRegex = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi;
          let siM;
          while ((siM = siRegex.exec(ssXml)) !== null) {
            const tMatches = Array.from(siM[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi));
            shared.push(tMatches.map(m => m[1]).join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
          }
        }
        const sheetKeys = Object.keys(entries).filter(k => k.toLowerCase().includes('worksheets/') && k.toLowerCase().endsWith('.xml')).sort();
        addDebugLog(`Shared strings: ${shared.length}, sheets: ${sheetKeys.length}`);
        for (const sk of sheetKeys) {
          const xml = entries[sk];
          const grid = [];
          const rowRegex = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/gi;
          let rMatch;
          while ((rMatch = rowRegex.exec(xml)) !== null) {
            const rowInner = rMatch[1];
            const rowArr = [];
            const cellRegex = /<(?:\w+:)?c\b([^>]*?)(\/?)>([\s\S]*?)<\/(?:\w+:)?c>|<(?:\w+:)?c\b([^>]*?)\/>/gi;
            let cMatch;
            while ((cMatch = cellRegex.exec(rowInner)) !== null) {
              const attrs = (cMatch[1] || cMatch[4] || '');
              const cellInner = (cMatch[2] === '/' ? '' : (cMatch[3] || ''));
              const refM = attrs.match(/\br=["']([A-Z]+\d+)["']/i);
              const typeM = attrs.match(/\bt=["']([^"']+)["']/i);
              const colIdx = refM ? colLettersToIdx(refM[1]) : rowArr.length;
              const type = typeM ? typeM[1] : '';
              let val = '';
              if (type === 's') {
                const vM = cellInner.match(/<(?:\w+:)?v[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i);
                val = vM ? (shared[parseInt(vM[1].trim(), 10)] || '') : '';
              } else if (type === 'inlineStr' || type === 'str') {
                const tMatches = Array.from(cellInner.matchAll(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi));
                if (tMatches.length) {
                  val = tMatches.map(m => m[1]).join('');
                } else {
                  const vM = cellInner.match(/<(?:\w+:)?v[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i);
                  val = vM ? vM[1] : '';
                }
              } else {
                const vM = cellInner.match(/<(?:\w+:)?v[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i);
                const tM = cellInner.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/i);
                val = vM ? vM[1] : (tM ? tM[1] : '');
              }
              rowArr[colIdx] = String(val).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            }
            if (rowArr.some(c => String(c || '').trim() !== '')) grid.push(rowArr);
          }
          const sampleRow = grid.find(r => r.filter(Boolean).length >= 2) || grid[0] || [];
          const idxRow = sampleRow.map((v, idx) => v !== '' && v != null ? `${idx}:${v}` : '').filter(Boolean).join(', ');
          addDebugLog(`Sheet ${sk.split('/').pop()}: ${grid.length} rows [${idxRow}]`);
          lastDetectedStatementDate = detectStatementDateFromGrid(grid);
          const rows = extractRowsFromGrid(grid);
          if (rows.length > 0) return { detectedSheet: sk.split('/').pop(), jsonRows: rows };
        }
        return { detectedSheet: 'Sheet1', jsonRows: [] };
      }

      document.getElementById('btnParsePaste').addEventListener('click', () => {
        const raw = document.getElementById('excelPasteInput').value.trim();
        const preview = document.getElementById('excelPreviewBox');
        const btnConfirm = document.getElementById('btnConfirmImport');
        if (!raw) {
          showToast('Paste table rows first');
          return;
        }
        try {
          const csvGrid = parseCsvGridNative(raw);
          parsedRows = extractRowsFromGrid(csvGrid);
          if (parsedRows.length === 0 && typeof XLSX !== 'undefined') {
            const wb = XLSX.read(raw, { type: 'string' });
            const res = extractRowsFromWorkbook(wb);
            parsedRows = res.jsonRows;
          } else {
            const lines = raw.split(/\r?\n/).filter(l => l.trim());
            const sep = lines[0].includes('\t') ? '\t' : ',';
            const headers = lines[0].split(sep).map(h => h.trim());
            parsedRows = lines.slice(1).map(line => {
              const cols = line.split(sep);
              const obj = {};
              headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
              return obj;
            });
          }
          preview.classList.remove('hidden');
          if (parsedRows.length > 0) {
            preview.innerHTML = `Found <strong>${parsedRows.length}</strong> pasted row(s). Ready to import!`;
            btnConfirm.disabled = false;
          } else {
            preview.innerHTML = '<span class="text-amber-300">Could not detect columns in pasted text. Include the header row.</span>';
            btnConfirm.disabled = true;
          }
        } catch (err) {
          preview.classList.remove('hidden');
          preview.innerHTML = `<span class="text-rose-400">Paste error: ${err.message || 'Invalid text'}</span>`;
          btnConfirm.disabled = true;
        }
      });

      document.getElementById('excelFileInput').addEventListener('change', async (e) => {
        const preview = document.getElementById('excelPreviewBox');
        const btnConfirm = document.getElementById('btnConfirmImport');
        const files = Array.from(e.target.files || []);
        if (files.length === 0) { addDebugLog('No file selected'); return; }
        preview.classList.remove('hidden');
        preview.innerHTML = `<span class="text-slate-300">Reading ${files.length} file(s)...</span>`;
        btnConfirm.disabled = true;
        parsedRows = [];

        const readFileAsBuf = (f) => new Promise((resolve, reject) => {
          const r = new FileReader();
          const t = setTimeout(() => reject(new Error('FileReader timeout under content://')), 4000);
          r.onload = (ev) => { clearTimeout(t); resolve(ev.target.result); };
          r.onerror = () => { clearTimeout(t); reject(new Error('FileReader blocked')); };
          r.readAsArrayBuffer(f);
        });

        try {
          const pdfPass = (document.getElementById('pdfPasswordInput') && document.getElementById('pdfPasswordInput').value.trim()) || '';
          for (const file of files) {
            addDebugLog(`Selected: ${file.name} (${file.size} bytes)`);
            const buf = await readFileAsBuf(file);
            const u8 = new Uint8Array(buf);
            const isPdf = u8.length >= 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;
            const isZip = u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4B;
            const isOle = u8.length >= 4 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0;

            if (isPdf) {
              addDebugLog(`Parsing PDF: ${file.name}`);
              const pdfGrid = await parsePdfBufferLocally(u8, pdfPass);
              lastDetectedStatementDate = detectStatementDateFromGrid(pdfGrid);
              const rows = extractRowsFromGrid(pdfGrid);
              addDebugLog(`PDF extracted ${rows.length} row(s) from ${pdfGrid.length} text lines`);
              parsedRows.push(...rows);
              continue;
            }
            if (!isZip && !isOle) {
              const text = new TextDecoder('utf-8').decode(u8);
              const csvGrid = parseCsvGridNative(text);
              lastDetectedStatementDate = detectStatementDateFromGrid(csvGrid);
              let rows = extractRowsFromGrid(csvGrid);
              if (rows.length === 0 && csvGrid.length >= 2) {
                const hdrs = csvGrid[0].map((h, i) => h || `col_${i}`);
                rows = csvGrid.slice(1).map(r => {
                  const obj = {};
                  hdrs.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
                  return obj;
                });
              }
              addDebugLog(`CSV ${file.name}: extracted ${rows.length} row(s)`);
              parsedRows.push(...rows);
              continue;
            }
            // ZIP / XLSX or XLS
            let wb = null;
            try {
              wb = XLSX.read(u8, { type: 'array', cellStyles: false, cellFormula: false });
            } catch (e1) {
              if (isZip) {
                const nativeRes = await parseBrokenXlsxLocally(u8);
                addDebugLog(`Native XML scanner (${file.name}): ${nativeRes.jsonRows.length} rows`);
                parsedRows.push(...nativeRes.jsonRows);
                continue;
              }
            }
            if (wb) {
              const res = extractRowsFromWorkbook(wb);
              addDebugLog(`Workbook ${file.name}: ${res.jsonRows.length} rows`);
              parsedRows.push(...res.jsonRows);
            }
          }

          if (parsedRows.length === 0) {
            preview.innerHTML = '<span class="text-amber-300">No holdings/transaction rows found. If importing a password-protected PDF, enter the password above and re-select the file.</span>';
            btnConfirm.disabled = true;
          } else {
            preview.innerHTML = `Found <strong>${parsedRows.length}</strong> total row(s) across <strong>${files.length}</strong> file(s). Ready to import with automatic deduplication!`;
            btnConfirm.disabled = false;
          }
        } catch (outerErr) {
          const msg = outerErr && outerErr.message ? outerErr.message : 'Could not read file';
          addDebugLog(`Import ERROR: ${msg}`);
          preview.innerHTML = `<span class="text-rose-400">${msg}. If this is a password-protected PDF, type your password in the box above and choose the file again.</span>`;
          btnConfirm.disabled = true;
        }
      });

      function normName(str) {
        return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      }

      document.getElementById('btnConfirmImport').addEventListener('click', () => {
        let addedCount = 0;
        let updatedCount = 0;
        if (targetType === 'mf') {
          // First remove any corrupt "Imported Holding #" rows from older v2.1 imports
          state.mutualFunds = state.mutualFunds.filter(f => !/^Imported Holding #/i.test(f.name));
          parsedRows.forEach((row, idx) => {
            const name = pickField(row, ['scheme name', 'fund name', 'scheme', 'fund', 'name']);
            const units = cleanNum(pickField(row, ['unit', 'qty', 'quantity']));
            if (!name || units <= 0) return;
            const orderDate = String(pickField(row, ['execution date', 'order date', 'transaction date', 'allotment date', 'date']) || '').trim();
            const orderStatus = String(pickField(row, ['status', 'order status']) || '').toUpperCase();
            if (orderStatus && (orderStatus.includes('FAIL') || orderStatus.includes('CANCEL') || orderStatus.includes('REJECT'))) return;
            const folio = String(pickField(row, ['folio']) || '').trim().replace(/\.0+$/, '');
            const known = KNOWN_FOLIOS[folio] || KNOWN_UNITS.find(k => Math.abs(k.units - units) < 0.01);
            const cleanName = (/^(Imported|Groww) Holding/i.test(String(name)) && known) ? known.name : String(name).trim();
            const code = String(pickField(row, ['scheme code', 'amfi', 'code']) || (known ? known.code : '000000')).trim();
            const cat = String(pickField(row, ['sub-category', 'subcategory', 'category', 'type']) || (known ? known.cat : 'Equity')).trim();
            const invested = cleanNum(pickField(row, ['invested value', 'invested', 'cost', 'buy value', 'amount'])) || (known ? known.invested : 0);
            const curVal = cleanNum(pickField(row, ['current value', 'market value'])) || (known ? known.curVal : 0);
            const nav = cleanNum(pickField(row, ['current nav', 'nav', 'price'])) || (curVal > 0 && units > 0 ? curVal / units : (invested > 0 ? invested / units : 100));
            const sip = cleanNum(pickField(row, ['sip', 'monthly']));

            // Check if this fund already exists (by schemeCode, folio, or normalized name)
            const existing = state.mutualFunds.find(f =>
              (code !== '000000' && f.schemeCode === code) ||
              (folio && f.folio === folio) ||
              normName(f.name) === normName(cleanName)
            );
            if (!Array.isArray(existing && existing.installments)) {
              if (existing) existing.installments = [];
            }
            if (orderDate) {
              // Order-level row (from Groww Order History or Gmail Sync)
              const purchaseNav = cleanNum(pickField(row, ['purchase nav', 'allotted nav', 'nav', 'price'])) || (invested > 0 ? invested / units : nav);
              const orderAmt = invested > 0 ? invested : (units * purchaseNav);
              const txKey = `${orderDate}_${units.toFixed(3)}_${Math.round(orderAmt)}`;
              let targetFund = existing;
              if (!targetFund) {
                targetFund = {
                  id: 'mf_imp_' + Date.now() + '_' + idx,
                  name: cleanName,
                  schemeCode: code,
                  folio: folio,
                  category: cat,
                  units: 0,
                  invested: 0,
                  currentNav: purchaseNav,
                  prevNav: purchaseNav,
                  monthlySip: sip,
                  installments: []
                };
                state.mutualFunds.push(targetFund);
                addedCount++;
              } else {
                updatedCount++;
              }
              // Check if an installment around this date (±5 days) with similar amount already exists (e.g. from Gmail Sync); if so, update it in-place to match the official report!
              const orderMs = new Date(orderDate).getTime();
              const existingInst = targetFund.installments.find(inst => {
                const diffDays = Math.abs(orderMs - new Date(inst.date).getTime()) / 86400000;
                return (inst.date === orderDate && Math.abs(Number(inst.units) - units) < 0.005) ||
                       (diffDays <= 5 && Math.abs(Number(inst.amount) - orderAmt) <= 50);
              });
              if (existingInst) {
                existingInst.date = orderDate;
                existingInst.amount = orderAmt;
                existingInst.nav = purchaseNav;
                existingInst.units = units;
              } else {
                targetFund.installments.push({
                  id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  date: orderDate,
                  amount: orderAmt,
                  nav: purchaseNav,
                  units: units
                });
              }
              targetFund.installments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
              if (!targetFund.statementUnits) {
                targetFund.units = +targetFund.installments.reduce((s, x) => s + Number(x.units || 0), 0).toFixed(3);
                targetFund.invested = +targetFund.installments.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2);
              }
            } else if (existing) {
              existing.name = cleanName;
              if (code !== '000000') existing.schemeCode = code;
              existing.category = cat;
              existing.folio = folio || existing.folio;
              existing.units = units;
              existing.invested = invested;
              existing.statementDate = lastDetectedStatementDate || new Date().toISOString().slice(0, 10);
              existing.statementUnits = units;
              existing.statementInvested = invested;
              existing.currentNav = nav;
              existing.prevNav = nav;
              if (sip > 0) existing.monthlySip = sip;
              updatedCount++;
            } else {
              const stmtDt = lastDetectedStatementDate || new Date().toISOString().slice(0, 10);
              state.mutualFunds.push({
                id: 'mf_imp_' + Date.now() + '_' + idx,
                name: cleanName,
                schemeCode: code,
                folio: folio,
                category: cat,
                units,
                invested,
                statementDate: stmtDt,
                statementUnits: units,
                statementInvested: invested,
                currentNav: nav,
                prevNav: nav,
                monthlySip: sip,
                installments: []
              });
              addedCount++;
            }
          });
        } else if (targetType === 'nps') {
          // Automatically purge any malformed v3.1 NPS cards (where name was a number like "14064.30" or started with "By ")
          state.nps = state.nps.filter(n => !/^(?:by\s+|\d+(?:\.\d+)?$)/i.test(String(n.name || '').trim()));

          parsedRows.forEach((row, idx) => {
            const name = pickField(row, ['scheme name', 'scheme details', 'pfm name', 'scheme', 'fund', 'particulars', 'name']);
            const rawUnitsVal = parseFloat(String(pickField(row, ['total units', 'balance units', 'no. of units', 'allotted units', 'unit', 'qty']) || '0').replace(/[₹,\s]/g, ''));
            if (!name || isNaN(rawUnitsVal) || rawUnitsVal === 0) return;
            const cleanName = String(name).trim();
            if (/^(?:by\s+|\d+(?:\.\d+)?$)/i.test(cleanName)) return;

            const codeOrTier = String(pickField(row, ['scheme code', 'code', 'tier', 'id']) || 'Tier I').trim();
            const txDate = row._rowType === 'summary'
              ? ''
              : String(pickField(row, ['transaction date', 'contribution date', 'allotment date']) || '').trim();
            const desc = String(row['Description'] || '').trim();
            const stmtDtFromRow = String(row['Statement Date'] || lastDetectedStatementDate || '').trim();
            const curVal = cleanNum(pickField(row, ['current value', 'market value', 'valuation', 'total value']));
            const rawAmtVal = parseFloat(String(pickField(row, ['invested value', 'invested', 'total contribution', 'contribution amount', 'amount', 'cost']) || '0').replace(/[₹,\s]/g, ''));
            const nav = cleanNum(pickField(row, ['latest nav', 'purchase nav', 'nav', 'price'])) || (curVal > 0 && rawUnitsVal > 0 ? +(curVal / rawUnitsVal).toFixed(4) : 20);
            const sip = cleanNum(pickField(row, ['monthly', 'sip']));

            const existing = state.nps.find(n => normName(n.name) === normName(cleanName));
            if (existing && !Array.isArray(existing.installments)) existing.installments = [];

            if ((row._rowType === 'tx' || row._rowType === 'opening' || (row._rowType !== 'summary' && txDate)) && (Math.abs(rawAmtVal) >= 0.01 || Math.abs(rawUnitsVal) >= 0.0001)) {
              let targetNps = existing;
              if (!targetNps) {
                targetNps = {
                  id: 'nps_imp_' + Date.now() + '_' + idx,
                  name: cleanName,
                  schemeId: codeOrTier,
                  units: 0,
                  invested: 0,
                  currentNav: nav,
                  prevNav: nav,
                  monthlySip: sip,
                  installments: []
                };
                state.nps.push(targetNps);
                addedCount++;
              } else {
                updatedCount++;
              }
              // Report is Source of Truth: match any existing contribution (±7 days) or quarterly billing deduction (same quarter or ±20 days) and update it in-place with the exact CSV values!
              const txMs = new Date(txDate).getTime();
              const qMatch = desc.match(/Q[1-4]\s*\d{4}[\-\/]\d{2,4}/i);
              const qKey = qMatch ? qMatch[0].toUpperCase() : '';
              const existingInst = targetNps.installments.find(inst => {
                if (row._rowType === 'opening') return inst.isOpeningBalance || /opening\s*balance/i.test(String(inst.desc || ''));
                if (inst.date === txDate && Math.abs(Number(inst.units) - rawUnitsVal) < 0.001) return true;
                const instMs = new Date(inst.date).getTime();
                const dayDiff = Math.abs(txMs - instMs) / 86400000;
                if (rawUnitsVal < 0 && Number(inst.units) < 0) {
                  if (qKey && String(inst.desc || '').toUpperCase().includes(qKey)) return true;
                  return dayDiff <= 20 && Math.abs(Number(inst.amount) - rawAmtVal) <= 15;
                }
                if (rawUnitsVal > 0 && Number(inst.units) > 0 && !inst.isOpeningBalance) {
                  return dayDiff <= 7 && Math.abs(Number(inst.amount) - rawAmtVal) <= Math.max(50, rawAmtVal * 0.05);
                }
                return false;
              });

              if (existingInst) {
                existingInst.date = txDate;
                existingInst.desc = desc || existingInst.desc;
                existingInst.amount = rawAmtVal;
                existingInst.nav = nav;
                existingInst.units = +rawUnitsVal.toFixed(4);
                existingInst.isOpeningBalance = row._rowType === 'opening';
                delete existingInst.isEstimatedBilling;
                if (String(existingInst.id || '').startsWith('nps_gmail_')) {
                  existingInst.id = 'npstx_verified_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                }
              } else {
                targetNps.installments.push({
                  id: 'npstx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  date: txDate,
                  desc: desc,
                  amount: rawAmtVal,
                  nav: nav,
                  units: +rawUnitsVal.toFixed(4),
                  isOpeningBalance: row._rowType === 'opening'
                });
              }
              targetNps.installments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
            } else {
              // Summary Holding Row (from Section 1 of Protean CSV)
              const stmtDt = stmtDtFromRow || new Date().toISOString().slice(0, 10);
              const totAccContrib = Number(row._totalAccountContribution || 0);
              const sharePct = /SCHEME\s*[\-:]?\s*E\b/i.test(cleanName) ? 0.75 : (/SCHEME\s*[\-:]?\s*C\b/i.test(cleanName) ? 0.10 : (/SCHEME\s*[\-:]?\s*G\b/i.test(cleanName) ? 0.15 : 0));
              const stmtInvestedFromHeader = (totAccContrib > 0 && sharePct > 0) ? +(totAccContrib * sharePct).toFixed(2) : 0;

              if (existing) {
                // Always update to the imported CSV's authoritative Scheme-wise Summary Total Units
                existing.name = cleanName;
                existing.statementDate = stmtDt;
                existing.statementUnits = +rawUnitsVal.toFixed(4);
                existing.statementValue = curVal;
                if (stmtInvestedFromHeader > 0) {
                  existing.statementInvested = stmtInvestedFromHeader;
                  existing.invested = stmtInvestedFromHeader;
                }
                existing.units = +rawUnitsVal.toFixed(4);
                existing.currentNav = nav;
                existing.prevNav = nav;
                updatedCount++;
              } else {
                state.nps.push({
                  id: 'nps_imp_' + Date.now() + '_' + idx,
                  name: cleanName,
                  schemeId: codeOrTier,
                  units: +rawUnitsVal.toFixed(4),
                  invested: stmtInvestedFromHeader > 0 ? stmtInvestedFromHeader : curVal,
                  statementDate: stmtDt,
                  statementUnits: +rawUnitsVal.toFixed(4),
                  statementInvested: stmtInvestedFromHeader,
                  statementValue: curVal,
                  currentNav: nav,
                  prevNav: nav,
                  monthlySip: sip,
                  installments: []
                });
                addedCount++;
              }
            }
          });

          // Exact Reconciliation: Section 1 (`Scheme-wise Summary`) `Total Units` in the Protean CSV is ALWAYS the exact official unit balance as of `statementDate`
          state.nps.forEach(n => {
            const insts = Array.isArray(n.installments) ? n.installments : [];
            const netTxUnits = +insts.reduce((s, x) => s + Number(x.units || 0), 0).toFixed(4);
            const grossTxInvested = +insts.filter(x => Number(x.amount) > 0).reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2);

            if (n.statementUnits > 0) {
              // Always lock to the exact Scheme-wise Summary Total Units from the CSV report (plus any post-statement Gmail units if dated strictly after statementDate)
              const stmtDt = String(n.statementDate || '');
              const postUnits = stmtDt
                ? insts.filter(x => String(x.date || '') > stmtDt && String(x.id || '').startsWith('nps_gmail_')).reduce((s, x) => s + Number(x.units || 0), 0)
                : 0;
              n.units = +(Number(n.statementUnits) + postUnits).toFixed(4);
              n.invested = grossTxInvested > 0 ? grossTxInvested : (n.statementValue || n.invested);
            } else if (insts.length > 0) {
              n.units = netTxUnits;
              n.invested = grossTxInvested;
            }
            if (insts.length > 0 && (!n.currentNav || n.currentNav === 20)) {
              n.currentNav = Number(insts[0].nav) || n.currentNav;
              n.prevNav = n.currentNav;
            }
          });
        } else if (targetType === 'retiral') {
          if (!Array.isArray(state.epf.installments)) state.epf.installments = [];
          if (!Array.isArray(state.epf.yearlyInterests)) state.epf.yearlyInterests = [];
          let hasPassbookRows = false;

          parsedRows.forEach((row) => {
            if (row._epfType === 'contribution') {
              hasPassbookRows = true;
              const exists = state.epf.installments.some(x => x.wageMonth === row.wageMonth && x.date === row.date && Math.abs(x.empShare - row.empShare) < 1);
              if (!exists) {
                state.epf.installments.push({
                  id: 'epf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  wageMonth: row.wageMonth,
                  date: row.date,
                  epfWage: row.epfWage || 0,
                  empShare: row.empShare,
                  emprShare: row.emprShare,
                  pensionShare: row.pensionShare || 0
                });
                addedCount++;
              } else {
                updatedCount++;
              }
              return;
            }
            if (row._epfType === 'interest') {
              hasPassbookRows = true;
              const existsInt = state.epf.yearlyInterests.some(x => x.date === row.date);
              if (!existsInt) {
                state.epf.yearlyInterests.push({
                  id: 'epfint_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  date: row.date,
                  fyLabel: row.fyLabel,
                  empInterest: row.empInterest,
                  emprInterest: row.emprInterest
                });
                addedCount++;
              } else {
                updatedCount++;
              }
              return;
            }

            if (row._ppfType === 'deposit' || row._ppfType === 'interest') {
              if (!Array.isArray(state.ppf.installments)) state.ppf.installments = [];
              const existsPpf = state.ppf.installments.some(x =>
                (row.txId && x.txId === row.txId) ||
                (x.date === row.date && Math.abs(Number(x.credit) - row.credit) < 1 && Math.abs(Number(x.balance) - row.balance) < 1)
              );
              if (!existsPpf) {
                state.ppf.installments.push({
                  id: 'ppf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  txId: row.txId,
                  kind: row._ppfType,
                  date: row.date,
                  desc: row.desc,
                  credit: row.credit,
                  debit: row.debit || 0,
                  balance: row.balance || 0
                });
                addedCount++;
              } else {
                updatedCount++;
              }
              row._handledPpf = true;
              return;
            }

            const label = String(pickField(row, ['type', 'account', 'ledger', 'name']) || '').toUpperCase();
            const bal = cleanNum(pickField(row, ['balance', 'closing', 'current', 'value']));
            const inv = cleanNum(pickField(row, ['invested', 'principal', 'contribution'])) || bal;
            const monthly = cleanNum(pickField(row, ['monthly', 'deposit', 'sip']));
            if (label.includes('EPF') && bal >= 0) {
              state.epf.balance = bal;
              state.epf.invested = inv;
              if (monthly > 0) state.epf.monthlyContribution = monthly;
              updatedCount++;
            } else if (label.includes('PPF') && bal >= 0) {
              state.ppf.balance = bal;
              state.ppf.invested = inv;
              if (monthly > 0) state.ppf.monthlyDeposit = monthly;
              updatedCount++;
            }
          });

          if (hasPassbookRows) {
            recalculateEpfFromPassbook();
          }
          if (parsedRows.some(r => r._ppfType)) {
            recalculatePpfFromPassbook();
          }
        }

        sanitizeNpsState(state);
        saveState();
        closeModal();
        renderAll();
        const totalChanged = addedCount + updatedCount + (typeof imported !== 'undefined' ? imported : 0);
        showToast(totalChanged > 0 ? `Added ${addedCount}, updated ${updatedCount} existing holding(s)` : 'No matching columns found—try the Sample CSV');
        if ((targetType === 'mf' || targetType === 'nps') && totalChanged > 0) syncLiveNavs();
      });
    }

    function openAddMfModal() {
      openModal('Add Mutual Fund', `
        <div class="space-y-3 text-xs">
          <div>
            <label class="block text-slate-400 mb-1">Search Scheme (optional, via MFapi.in)</label>
            <div class="flex gap-2">
              <input id="mfSearchInput" type="text" placeholder="e.g. Parag Parikh or UTI Nifty" class="flex-1 px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white focus:outline-none focus:border-emerald-500" />
              <button id="btnSearchMfApi" type="button" class="px-3 py-2 rounded-xl bg-surface-700 text-white font-semibold">Search</button>
            </div>
            <div id="mfSearchResults" class="mt-2 max-h-48 overflow-y-auto overscroll-contain touch-scroll-list space-y-1 rounded-xl"></div>
          </div>
          <input id="mfName" type="text" placeholder="Fund Name" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          <div class="grid grid-cols-2 gap-2">
            <input id="mfCode" type="text" placeholder="AMFI Code (e.g. 122639)" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="mfCat" type="text" placeholder="Category (e.g. Flexi Cap)" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <input id="mfUnits" type="number" step="0.001" placeholder="Units Held" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="mfInvested" type="number" step="1" placeholder="Invested ₹" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <input id="mfNav" type="number" step="0.01" placeholder="Current NAV ₹ (auto-syncs)" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="mfSip" type="number" step="100" placeholder="Monthly SIP ₹" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <button id="btnSaveMf" type="button" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Save Mutual Fund</button>
        </div>
      `);

      document.getElementById('btnSearchMfApi').addEventListener('click', async () => {
        const q = document.getElementById('mfSearchInput').value.trim();
        if (!q) return;
        const resBox = document.getElementById('mfSearchResults');
        resBox.innerHTML = '<p class="text-slate-400">Searching...</p>';
        try {
          const res = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
          const list = await res.json();
          const subset = Array.isArray(list) ? list.slice(0, 50) : [];
          resBox.innerHTML = subset.length > 0
            ? `<p class="text-[10px] text-slate-400 px-1 pb-1">Showing ${subset.length} of ${list.length} matches (scroll down for more):</p>` + subset.map(item => `
            <button type="button" data-pick-code="${item.schemeCode}" data-pick-name="${item.schemeName.replace(/"/g, '&quot;')}" class="w-full text-left px-2.5 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 border border-slate-700/60 text-slate-200 leading-snug break-words">
              <span class="text-emerald-400 font-bold">${item.schemeCode}</span> — ${item.schemeName}
            </button>
          `).join('')
            : '<p class="text-slate-500">No schemes found.</p>';
        } catch (e) {
          resBox.innerHTML = '<p class="text-rose-400">Search unavailable offline.</p>';
        }
      });

      document.getElementById('mfSearchResults').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pick-code]');
        if (!btn) return;
        document.getElementById('mfCode').value = btn.getAttribute('data-pick-code');
        document.getElementById('mfName').value = btn.getAttribute('data-pick-name');
        document.getElementById('mfSearchResults').innerHTML = '';
      });

      document.getElementById('btnSaveMf').addEventListener('click', () => {
        const name = document.getElementById('mfName').value.trim();
        const code = document.getElementById('mfCode').value.trim() || '000000';
        const cat = document.getElementById('mfCat').value.trim() || 'Equity';
        const units = parseFloat(document.getElementById('mfUnits').value) || 0;
        const invested = parseFloat(document.getElementById('mfInvested').value) || 0;
        const nav = parseFloat(document.getElementById('mfNav').value) || 100;
        const sip = parseFloat(document.getElementById('mfSip').value) || 0;
        if (!name || units <= 0) {
          showToast('Enter a fund name and valid units');
          return;
        }
        state.mutualFunds.push({
          id: 'mf_' + Date.now(),
          name, schemeCode: code, category: cat,
          units, invested, currentNav: nav, prevNav: nav, monthlySip: sip
        });
        saveState();
        closeModal();
        renderAll();
        syncLiveNavs();
      });
    }

    function openAddNpsModal() {
      openModal('Add NPS Scheme', `
        <div class="space-y-3 text-xs">
          <div>
            <label class="block text-slate-400 mb-1">Search Official NPS Scheme (via NPSNAV.in API):</label>
            <div class="flex gap-2">
              <input id="npsSearchInput" type="text" placeholder="e.g. HDFC Equity or SBI Tier I" class="flex-1 px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white focus:outline-none focus:border-amber-500" />
              <button id="btnSearchNpsApi" type="button" class="px-3 py-2 rounded-xl bg-surface-700 text-white font-semibold">Search</button>
            </div>
            <div id="npsSearchResults" class="mt-2 max-h-48 overflow-y-auto overscroll-contain touch-scroll-list space-y-1 rounded-xl"></div>
          </div>
          <input id="npsName" type="text" placeholder="Scheme Name (e.g. HDFC Pension Fund Scheme E - Tier I)" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          <input id="npsId" type="text" placeholder="NPS Scheme Code (e.g. SM008001)" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          <div class="grid grid-cols-2 gap-2">
            <input id="npsUnits" type="number" step="0.0001" placeholder="Units Held (4 decimals)" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="npsInvested" type="number" step="0.01" placeholder="Invested ₹" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <input id="npsNav" type="number" step="0.0001" placeholder="Current NAV ₹ (auto-syncs)" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="npsSip" type="number" step="100" placeholder="Monthly Contribution ₹" class="px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <button id="btnSaveNps" type="button" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Save NPS Scheme</button>
        </div>
      `);

      document.getElementById('btnSearchNpsApi').addEventListener('click', async () => {
        const q = document.getElementById('npsSearchInput').value.trim().toLowerCase();
        if (!q) return;
        const resBox = document.getElementById('npsSearchResults');
        resBox.innerHTML = '<p class="text-slate-400">Searching NPSNAV.in...</p>';
        try {
          const res = await fetch('https://npsnav.in/api/schemes');
          const json = await res.json();
          const list = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
          const words = q.split(/\s+/).filter(Boolean);
          const matches = list.filter(entry => {
            const code = String(Array.isArray(entry) ? entry[0] : (entry.scheme_code || entry.code || '')).toLowerCase();
            const name = String(Array.isArray(entry) ? entry[1] : (entry.scheme_name || entry.name || '')).toLowerCase();
            return words.every(w => name.includes(w) || code.includes(w));
          }).slice(0, 50);
          resBox.innerHTML = matches.map(entry => {
            const code = String(Array.isArray(entry) ? entry[0] : (entry.scheme_code || entry.code || ''));
            const name = String(Array.isArray(entry) ? entry[1] : (entry.scheme_name || entry.name || ''));
            return `
              <button type="button" data-pick-nps-code="${code}" data-pick-nps-name="${name.replace(/"/g, '&quot;')}" class="w-full text-left px-2.5 py-1.5 rounded-lg bg-surface-800 hover:bg-surface-700 text-slate-200 truncate">
                <strong class="text-amber-400">${code}</strong> — ${name}
              </button>
            `;
          }).join('') || '<p class="text-slate-500">No matching NPS schemes found.</p>';
        } catch (e) {
          resBox.innerHTML = '<p class="text-rose-400">Search unavailable offline.</p>';
        }
      });

      document.getElementById('npsSearchResults').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pick-nps-code]');
        if (!btn) return;
        document.getElementById('npsId').value = btn.getAttribute('data-pick-nps-code');
        document.getElementById('npsName').value = btn.getAttribute('data-pick-nps-name');
        document.getElementById('npsSearchResults').innerHTML = '';
      });

      document.getElementById('btnSaveNps').addEventListener('click', () => {
        const name = document.getElementById('npsName').value.trim();
        const schemeId = document.getElementById('npsId').value.trim() || 'TIER-I';
        const units = parseFloat(document.getElementById('npsUnits').value) || 0;
        const invested = parseFloat(document.getElementById('npsInvested').value) || 0;
        const nav = parseFloat(document.getElementById('npsNav').value) || 40;
        const sip = parseFloat(document.getElementById('npsSip').value) || 0;
        if (!name || units <= 0) {
          showToast('Enter scheme name and valid units');
          return;
        }
        const stmtDt = new Date().toISOString().slice(0, 10);
        state.nps.push({
          id: 'nps_' + Date.now(),
          name, schemeId, units, invested,
          statementDate: stmtDt,
          statementUnits: units,
          statementInvested: invested,
          currentNav: nav, prevNav: nav, monthlySip: sip,
          installments: []
        });
        saveState();
        closeModal();
        renderAll();
        syncLiveNavs();
      });
    }

    function recalculateEpfFromPassbook() {
      const insts = Array.isArray(state.epf.installments) ? state.epf.installments : [];
      const ints = Array.isArray(state.epf.yearlyInterests) ? state.epf.yearlyInterests : [];
      insts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      ints.sort((a, b) => String(b.date).localeCompare(String(a.date)));

      const totalEmp = insts.reduce((s, x) => s + Number(x.empShare || 0), 0);
      const totalEmpr = insts.reduce((s, x) => s + Number(x.emprShare || 0), 0);
      const totalPen = insts.reduce((s, x) => s + Number(x.pensionShare || 0), 0);
      const totalInt = ints.reduce((s, x) => s + Number(x.empInterest || 0) + Number(x.emprInterest || 0), 0);

      state.epf.invested = totalEmp + totalEmpr;
      state.epf.totalInterestEarned = totalInt;
      state.epf.balance = totalEmp + totalEmpr + totalInt;
      state.epf.pensionBalance = totalPen;
      // Set default monthly contribution from the most recent passbook month
      if (insts.length > 0) {
        const latest = insts[0];
        state.epf.monthlyContribution = Number(latest.empShare || 0) + Number(latest.emprShare || 0);
        state.epf.latestEmpShare = Number(latest.empShare || 0);
        state.epf.latestEmprShare = Number(latest.emprShare || 0);
        state.epf.latestPensionShare = Number(latest.pensionShare || 0);
      }
    }

    function openEpfPassbookModal() {
      if (!Array.isArray(state.epf.installments)) state.epf.installments = [];
      if (!Array.isArray(state.epf.yearlyInterests)) state.epf.yearlyInterests = [];
      const insts = state.epf.installments;
      const ints = state.epf.yearlyInterests;

      const totalEmp = insts.reduce((s, x) => s + Number(x.empShare || 0), 0);
      const totalEmpr = insts.reduce((s, x) => s + Number(x.emprShare || 0), 0);
      const totalInt = ints.reduce((s, x) => s + Number(x.empInterest || 0) + Number(x.emprInterest || 0), 0);
      const totalPen = insts.reduce((s, x) => s + Number(x.pensionShare || 0), 0);

      const intHtml = ints.length > 0
        ? ints.map(yr => `
            <div class="flex items-center justify-between py-1.5 border-b border-slate-800/80 text-xs">
              <span class="text-slate-300 font-medium">Interest upto ${yr.date}</span>
              <span class="font-bold text-emerald-400">+${formatINR(yr.empInterest + yr.emprInterest)} <span class="text-[10px] text-slate-400">(Emp: ₹${yr.empInterest} • Empr: ₹${yr.emprInterest})</span></span>
            </div>
          `).join('')
        : '<p class="text-slate-500 text-xs">No annual interest rows imported yet.</p>';

      const txHtml = insts.length > 0
        ? insts.map(tx => `
            <div class="flex items-center justify-between py-2 border-b border-slate-800/80 text-xs">
              <div>
                <p class="font-semibold text-white">${tx.wageMonth} <span class="text-[10px] text-slate-400 font-normal">(Credited ${tx.date})</span></p>
                <p class="text-[11px] text-slate-400">Emp+VPF: ₹${tx.empShare.toLocaleString('en-IN')} • Empr: ₹${tx.emprShare.toLocaleString('en-IN')} • EPS: ₹${(tx.pensionShare || 0).toLocaleString('en-IN')}</p>
              </div>
              <div class="flex items-center gap-2">
                <span class="font-bold text-sky-400">+${formatINR(tx.empShare + tx.emprShare)}</span>
                ${currentUserRole === "admin" ? `<button type="button" data-del-epf-tx="${tx.id}" class="text-slate-500 hover:text-rose-400 px-1">✕</button>` : ""}
              </div>
            </div>
          `).join('')
        : '<p class="text-slate-500 text-xs py-2">No monthly passbook rows yet. Tap <strong>Import PDF/CSV/Excel</strong> on the EPF &amp; PPF tab and select all your 2018–2026 EPFO Passbook PDFs at once!</p>';

      openModal('EPF Passbook Ledger (2018 – Present)', `
        <div class="space-y-3 text-xs">
          <div class="grid grid-cols-2 gap-2 rounded-2xl bg-surface-800 p-3 border border-slate-700/70">
            <div>
              <p class="text-[10px] text-slate-400 uppercase">Employee + VPF Share</p>
              <p class="text-sm font-bold text-white mt-0.5">${formatINR(totalEmp)}</p>
            </div>
            <div>
              <p class="text-[10px] text-slate-400 uppercase">Employer EPF Share</p>
              <p class="text-sm font-bold text-white mt-0.5">${formatINR(totalEmpr)}</p>
            </div>
            <div>
              <p class="text-[10px] text-slate-400 uppercase">Total Interest Credited</p>
              <p class="text-sm font-bold text-emerald-400 mt-0.5">+${formatINR(totalInt)}</p>
            </div>
            <div>
              <p class="text-[10px] text-slate-400 uppercase">EPS Pension Pool</p>
              <p class="text-sm font-bold text-amber-400 mt-0.5">${formatINR(totalPen)}</p>
            </div>
          </div>

          <div>
            <h4 class="font-bold text-slate-200 mb-1">Annual Interest Credited (${ints.length} FYs)</h4>
            <div class="max-h-28 overflow-y-auto pr-1">${intHtml}</div>
          </div>

          <div>
            <h4 class="font-bold text-slate-200 mb-1">Monthly Contributions (${insts.length} Months)</h4>
            <div id="epfTxHistoryContainer" class="max-h-48 overflow-y-auto pr-1">${txHtml}</div>
          </div>
        </div>
      `);

      document.getElementById('epfTxHistoryContainer').addEventListener('click', (ev) => {
        const delBtn = ev.target.closest('[data-del-epf-tx]');
        if (!delBtn) return;
        const txId = delBtn.getAttribute('data-del-epf-tx');
        state.epf.installments = state.epf.installments.filter(x => x.id !== txId);
        recalculateEpfFromPassbook();
        saveState();
        renderAll();
        openEpfPassbookModal();
      });
    }

    function recalculatePpfFromPassbook() {
      const insts = Array.isArray(state.ppf.installments) ? state.ppf.installments : [];
      if (insts.length === 0) return;
      // Sort newest first; if same date (e.g. two deposits on 01-Apr-2026), sort by higher balance first
      insts.sort((a, b) => {
        const cmp = String(b.date).localeCompare(String(a.date));
        return cmp !== 0 ? cmp : (Number(b.balance || 0) - Number(a.balance || 0));
      });
      const totalDeposits = insts.filter(x => x.kind !== 'interest').reduce((s, x) => s + Number(x.credit || 0) - Number(x.debit || 0), 0);
      const totalInterest = insts.filter(x => x.kind === 'interest').reduce((s, x) => s + Number(x.credit || 0), 0);

      state.ppf.invested = totalDeposits;
      state.ppf.totalInterestEarned = totalInterest;
      state.ppf.balance = totalDeposits + totalInterest;
    }

    function openPpfPassbookModal() {
      if (!Array.isArray(state.ppf.installments)) state.ppf.installments = [];
      const insts = state.ppf.installments;
      const totalDeposits = insts.filter(x => x.kind !== 'interest').reduce((s, x) => s + Number(x.credit || 0) - Number(x.debit || 0), 0);
      const totalInterest = insts.filter(x => x.kind === 'interest').reduce((s, x) => s + Number(x.credit || 0), 0);

      const txHtml = insts.length > 0
        ? insts.map(tx => {
            const isInt = tx.kind === 'interest';
            return `
              <div class="flex items-center justify-between py-2 border-b border-slate-800/80 text-xs">
                <div>
                  <p class="font-semibold text-white">${tx.date} <span class="text-[10px] px-1.5 py-0.5 rounded ml-1 ${isInt ? 'bg-emerald-500/20 text-emerald-300' : 'bg-violet-500/20 text-violet-300'}">${isInt ? 'Interest Paid' : 'Deposit'}</span></p>
                  <p class="text-[11px] text-slate-400">${tx.desc || ''} ${tx.balance ? `• Bal: ₹${Number(tx.balance).toLocaleString('en-IN')}` : ''}</p>
                </div>
                <div class="flex items-center gap-2">
                  <span class="font-bold ${isInt ? 'text-emerald-400' : 'text-violet-300'}">+${formatINR(tx.credit)}</span>
                  ${currentUserRole === "admin" ? `<button type="button" data-del-ppf-tx="${tx.id}" class="text-slate-500 hover:text-rose-400 px-1">✕</button>` : ""}
                </div>
              </div>
            `;
          }).join('')
        : '<p class="text-slate-500 text-xs py-2">No PPF transactions yet. Upload your PPF Statement PDF via <strong>Import PDF/CSV/Excel</strong> or add a deposit below.</p>';

      openModal('PPF Passbook & Manual Entry', `
        <div class="space-y-3 text-xs">
          <div class="grid grid-cols-3 gap-2 rounded-2xl bg-surface-800 p-3 border border-slate-700/70">
            <div>
              <p class="text-[10px] text-slate-400 uppercase">Principal</p>
              <p class="text-sm font-bold text-white mt-0.5">${formatINR(totalDeposits || state.ppf.invested)}</p>
            </div>
            <div>
              <p class="text-[10px] text-slate-400 uppercase">Interest Earned</p>
              <p class="text-sm font-bold text-emerald-400 mt-0.5">+${formatINR(totalInterest || state.ppf.totalInterestEarned || 0)}</p>
            </div>
            <div class="text-right">
              <p class="text-[10px] text-slate-400 uppercase">Total Balance</p>
              <p class="text-sm font-extrabold text-white mt-0.5">${formatINR(state.ppf.balance)}</p>
            </div>
          </div>

          <div>
            <h4 class="font-bold text-slate-200 mb-1">PPF Transaction History (${insts.length} Entries)</h4>
            <div id="ppfTxHistoryContainer" class="max-h-48 overflow-y-auto pr-1">${txHtml}</div>
          </div>

          <div class="${currentUserRole === "admin" ? "" : "hidden "}pt-2 border-t border-slate-800 space-y-2">
            <p class="font-semibold text-slate-300">+ Add New PPF Deposit or Annual Interest</p>
            <div class="grid grid-cols-3 gap-2">
              <input id="ppfNewDate" type="date" value="${new Date().toISOString().slice(0, 10)}" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
              <select id="ppfNewKind" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white">
                <option value="deposit">PPF Deposit</option>
                <option value="interest">PPF Interest</option>
              </select>
              <input id="ppfNewAmount" type="number" step="500" placeholder="Amount ₹" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            </div>
            <button id="btnAddPpfManualEntry" type="button" class="w-full py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-bold">Add PPF Entry</button>
          </div>
        </div>
      `);

      document.getElementById('btnAddPpfManualEntry').addEventListener('click', () => {
        const dt = document.getElementById('ppfNewDate').value || new Date().toISOString().slice(0, 10);
        const kind = document.getElementById('ppfNewKind').value;
        const amt = parseFloat(document.getElementById('ppfNewAmount').value) || 0;
        if (amt <= 0) {
          showToast('Enter a valid PPF amount');
          return;
        }
        const newBal = (state.ppf.balance || 0) + amt;
        state.ppf.installments.push({
          id: 'ppf_man_' + Date.now(),
          txId: 'MAN_' + Date.now(),
          kind: kind,
          date: dt,
          desc: kind === 'interest' ? 'PPF Interest Paid' : 'PPF Subscription',
          credit: amt,
          debit: 0,
          balance: newBal
        });
        recalculatePpfFromPassbook();
        saveState();
        renderAll();
        openPpfPassbookModal();
        showToast(`Added ${formatINR(amt)} to PPF`);
      });

      document.getElementById('ppfTxHistoryContainer').addEventListener('click', (ev) => {
        const delBtn = ev.target.closest('[data-del-ppf-tx]');
        if (!delBtn) return;
        const txId = delBtn.getAttribute('data-del-ppf-tx');
        state.ppf.installments = state.ppf.installments.filter(x => x.id !== txId);
        recalculatePpfFromPassbook();
        saveState();
        renderAll();
        openPpfPassbookModal();
      });
    }

    function openRetiralEditModal(type) {
      const isEpf = type === 'epf';
      const obj = isEpf ? state.epf : state.ppf;
      openModal(isEpf ? 'Edit EPF Ledger' : 'Edit PPF Ledger', `
        <div class="space-y-3 text-xs">
          <div>
            <label class="block text-slate-400 mb-1">Current Balance (₹)</label>
            <input id="retBal" type="number" value="${obj.balance}" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <div>
            <label class="block text-slate-400 mb-1">Total Invested / Principal (₹)</label>
            <input id="retInv" type="number" value="${obj.invested}" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <div>
            <label class="block text-slate-400 mb-1">Monthly Contribution (₹)</label>
            <input id="retMonthly" type="number" value="${isEpf ? obj.monthlyContribution : obj.monthlyDeposit}" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <div>
            <label class="block text-slate-400 mb-1">Annual Interest Rate (% p.a.)</label>
            <input id="retRate" type="number" step="0.05" value="${(Number(obj.rate || (isEpf ? 0.0825 : 0.071)) * 100).toFixed(2)}" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
          </div>
          <button id="btnSaveRetiral" type="button" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Save Changes</button>
        </div>
      `);
      document.getElementById('btnSaveRetiral').addEventListener('click', () => {
        obj.balance = parseFloat(document.getElementById('retBal').value) || 0;
        obj.invested = parseFloat(document.getElementById('retInv').value) || 0;
        const m = parseFloat(document.getElementById('retMonthly').value) || 0;
        const rPct = parseFloat(document.getElementById('retRate').value);
        if (!isNaN(rPct) && rPct > 0) obj.rate = rPct / 100;
        if (isEpf) obj.monthlyContribution = m; else obj.monthlyDeposit = m;
        saveState();
        closeModal();
        renderAll();
        showToast(`${type.toUpperCase()} updated`);
      });
    }