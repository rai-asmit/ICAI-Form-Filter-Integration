const pLimit = require("p-limit").default;
const { netsuiteRequest } = require("./netsuiteClient--Rest");
const {
    readState,
    writeState,
    getRecordKey,
} = require("./transactionStateManager");

// Configuration
const MAX_RECORDS_PER_BATCH = 200;
const DELETION_CONCURRENCY = 10;

// Record type mapping for REST API (used for DELETE)
const RECORD_TYPE_MAP = {
    SalesOrder: "salesOrder",
    Invoice: "invoice",
    CustomerDeposit: "customerDeposit",
    CustomerPayment: "customerPayment",
};

// SuiteQL type codes (different from REST API names)
const SUITEQL_TYPE_MAP = {
    SalesOrder: "SalesOrd",
    Invoice: "CustInvc",
    CustomerDeposit: "CustDep",
    CustomerPayment: "CustPymt",
};

/**
 * Search/Preview records based on filter criteria
 * Returns matching records WITHOUT deleting them
 */
async function searchRecords(filters) {
    const {
        recordType,
        createDateFrom,
        createDateTo,
        status,
        recordNumber,
    } = filters;

    // Validate record type
    if (!RECORD_TYPE_MAP[recordType]) {
        throw new Error(
            `Invalid recordType. Must be one of: ${Object.keys(RECORD_TYPE_MAP).join(", ")}`
        );
    }

    // Build SuiteQL query
    const conditions = [];
    conditions.push(`t.type = '${SUITEQL_TYPE_MAP[recordType]}'`);

    // Date filters
    if (createDateFrom) {
        const [day, month, year] = createDateFrom.split("/");
        conditions.push(`t.createddate >= TO_DATE('${day}/${month}/${year}', 'DD/MM/YYYY')`);
    }

    if (createDateTo) {
        const [day, month, year] = createDateTo.split("/");
        conditions.push(`t.createddate <= TO_DATE('${day}/${month}/${year}', 'DD/MM/YYYY')`);
    }

    // Status filter
    if (status) {
        conditions.push(`BUILTIN.DF(t.status) = '${status}'`);
    }

    // Record number filter
    if (recordNumber) {
        conditions.push(`t.tranid = '${recordNumber}'`);
    }

    // Always filter by ICAI subsidiary
    // conditions.push(`t.subsidiary = 171`);

    const query = `
    SELECT 
      t.id,
      t.tranid,
      t.trandate,
      t.createddate,
      t.status,
      BUILTIN.DF(t.status) AS status_name,
      t.entity,
      BUILTIN.DF(t.entity) AS customer_name,
      t.total
    FROM transaction t
    WHERE ${conditions.join(" AND ")}
    ORDER BY t.createddate DESC
  `;

    console.log(`[Search] Query: ${query.replace(/\s+/g, " ").trim()}`);

    try {
        const result = await netsuiteRequest(
            "POST",
            `/services/rest/query/v1/suiteql?limit=${MAX_RECORDS_PER_BATCH}`,
            { q: query }
        );

        const records = result.items || [];
        console.log(`[Search] Found ${records.length} records matching criteria`);

        return {
            success: true,
            count: records.length,
            maxLimit: MAX_RECORDS_PER_BATCH,
            records: records.map((r) => ({
                id: r.id,
                recordNumber: r.tranid,
                date: r.trandate,
                createdDate: r.createddate,
                status: r.status_name,
                customerName: r.customer_name,
                total: r.total,
            })),
        };
    } catch (err) {
        console.error("[Search] Error:", err.response?.data || err.message);
        throw err;
    }
}

/**
 * Delete records from NetSuite
 * Requires explicit confirmation and record IDs from preview
 */
async function deleteRecords(payload) {
    const { recordType, recordIds, confirm } = payload;

    // Safety checks
    if (!confirm) {
        throw new Error("Deletion requires explicit confirmation. Set 'confirm: true'");
    }

    if (!RECORD_TYPE_MAP[recordType]) {
        throw new Error(
            `Invalid recordType. Must be one of: ${Object.keys(RECORD_TYPE_MAP).join(", ")}`
        );
    }

    if (!Array.isArray(recordIds) || recordIds.length === 0) {
        throw new Error("recordIds must be a non-empty array");
    }

    if (recordIds.length > MAX_RECORDS_PER_BATCH) {
        throw new Error(
            `Cannot delete more than ${MAX_RECORDS_PER_BATCH} records at once. Received ${recordIds.length}`
        );
    }

    console.log(`[Delete] Starting deletion of ${recordIds.length} ${recordType} records`);

    const nsRecordType = RECORD_TYPE_MAP[recordType];
    const limit = pLimit(DELETION_CONCURRENCY);
    const results = [];

    // Delete records with concurrency control
    const tasks = recordIds.map((id, index) =>
        limit(async () => {
            try {
                console.log(`[Delete] [${index + 1}/${recordIds.length}] Deleting ${recordType} ${id}`);

                await netsuiteRequest(
                    "DELETE",
                    `/services/rest/record/v1/${nsRecordType}/${id}`
                );

                results.push({
                    success: true,
                    recordId: id,
                    recordType,
                });

                console.log(`✅ Deleted ${recordType} ${id}`);
            } catch (err) {
                const errMsg = err.response?.data || err.message;
                console.error(`❌ Failed to delete ${recordType} ${id}:`, errMsg);

                results.push({
                    success: false,
                    recordId: id,
                    recordType,
                    error: errMsg,
                });
            }
        })
    );

    await Promise.all(tasks);

    // Summary
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    console.log(`[Delete] Summary: ${successCount} deleted, ${failCount} failed`);

    // Clean up state files for successfully deleted records
    if (successCount > 0) {
        await cleanupStateFiles(recordType, results.filter((r) => r.success));
    }

    return {
        success: true,
        message: `Deleted ${successCount} records, ${failCount} failed`,
        summary: {
            total: recordIds.length,
            successful: successCount,
            failed: failCount,
        },
        results,
    };
}

/**
 * Remove deleted records from state files
 * This prevents orphaned records in incoming/sales_order_done/etc.
 */
async function cleanupStateFiles(recordType, deletedRecords) {
    console.log(`[Cleanup] Cleaning up state files for ${deletedRecords.length} deleted records`);

    // Only clean up Sales Order state files (others are queried directly from NetSuite)
    if (recordType !== "SalesOrder") {
        console.log(`[Cleanup] Skipping state cleanup for ${recordType} (not tracked in state files)`);
        return;
    }

    const deletedSOIds = new Set(deletedRecords.map((r) => String(r.recordId)));

    // Clean up each state file
    const stateFiles = ["incoming", "sales_order_done", "invoice_done"];

    for (const stateName of stateFiles) {
        try {
            const records = readState(stateName);
            const remaining = records.filter(
                (r) => !deletedSOIds.has(String(r._soId))
            );

            if (remaining.length < records.length) {
                writeState(stateName, remaining);
                console.log(
                    `[Cleanup] Removed ${records.length - remaining.length} records from ${stateName}.json`
                );
            }
        } catch (err) {
            console.error(`[Cleanup] Error cleaning ${stateName}:`, err.message);
        }
    }
}

module.exports = {
    searchRecords,
    deleteRecords,
    MAX_RECORDS_PER_BATCH,
};
