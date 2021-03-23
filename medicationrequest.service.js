const { DataTypes } = require("sequelize");
const sequelize = require('./dbconfig').db;
//Specific models for our legacy person object
const Person = require('./models/PERSON');
const PersonDoc = require('./models/PERSON_DOC');
const DocType = require('./models/DOC_TYPE');
const Medication = require('./models/MEDICATION');
const Prescription = require('./models/PRECRIPTION');
const Medication_Prescription = require('./models/MEDICATION_PRESCRIPTION');
//Mapping between FHIR system and legacy document type
const LegacyDocumentType = require('./legacy_document_type');
//UID generator for bundles
const uuidv4 = require('uuid').v4;
//FHIR specific stuff: Server, resources: Patient, Bundle, OperationOutcome and Entry
const { RESOURCES } = require('@asymmetrik/node-fhir-server-core').constants;
const FHIRServer = require('@asymmetrik/node-fhir-server-core');
const getPatient = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/patient');
const getMedicationRequest = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/medicationrequest');
const getBundle = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/bundle');
const getOperationOutcome = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/operationoutcome');
const getBundleEntry = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/bundleentry');
//Meta data for FHIR R4
let getMeta = (base_version) => {
    return require(FHIRServer.resolveFromVersion(base_version, RESOURCES.META));
};
//How to search the address of our server, so we can return it in the fullURL for each Patient entry
function GetBaseUrl(context) {
    var baseUrl = "";
    const FHIRVersion = "/4_0_0/";
    var protocol = "http://";
    if (context.req.secure) { protocol = "https://"; }
    baseUrl = protocol + context.req.headers.host + FHIRVersion;
    return baseUrl;
};

module.exports.search = (args, context, logger) => new Promise(async (resolve, reject) => {
    // Common search params, we only support _id
    let { base_version, _content, _format, _id, _lastUpdated, _profile, _query, _security, _tag } = args;

    // Search Result params ,we only support _count
    let { _INCLUDE, _REVINCLUDE, _SORT, _COUNT, _SUMMARY, _ELEMENTS, _CONTAINED, _CONTAINEDTYPED } = args;
    let completePatient = null;

    let baseUrl = GetBaseUrl(context);
    // These are the parameters we can search for : name, identifier, family, gender and birthDate
    let patient = args['patient'];
    // let iden = args['identifier'];

    // Special parameters to support pagination
    let coun = context.req.query['_count'];
    let page = context.req.query['_page'];
    // Special search parameter to search by Id instead of direct read
    let idx = args[_id];
    // Our instance of the tables of the legacy database
    let person = new Person(sequelize, DataTypes);
    let medication = new Medication(sequelize, DataTypes);
    let prescription = new Prescription(sequelize, DataTypes);
    let medication_prescription = new Medication_Prescription(sequelize, DataTypes);
    prescription.belongsTo(person, {
        as: "PERSON",
        foreignKey: 'patient_id'
    });

    medication.belongsToMany(prescription, { through: medication_prescription });
    prescription.belongsToMany(medication, { through: medication_prescription });

    try {
        let criteria = [];
        // If the family name is a parameter in this specific request...
        if (patient) {
            criteria.push({ patient_id: patient });
            completePatient = await person.findOne({
                where: { PRSN_ID: patient }
            });
        };
        include = [{
            model: medication
        }];

        let result = await GetMedicationRequest(prescription, completePatient, include, criteria, context, coun, page);
        resolve(result);
    } catch (e) {
        reject(e);
    }

});

function GetMedicationRequest(prescription, completePatient, include, criteria, context, coun, page) {
    return new Promise(
        function (resolve, reject) {
            //Here we solve paginations issues: how many records per page, which page
            let offset = 0
            let limit = 0
            if (!coun) { coun = 5; }
            if (coun === "") { coun = 5; }
            let pageSize = parseInt(coun);

            if (!page) { page = 1; }
            if (page === "") { page = 1; }
            pageInt = parseInt(page);
            offset = (pageInt - 1) * pageSize;
            limit = pageSize;
            //Bundle and Entry definitions
            let BundleEntry = getBundleEntry;
            let Bundle = getBundle;
            //Our Base address
            let baseUrl = GetBaseUrl(context);

            result = [];
            entries = [];

            prescription.findAndCountAll({
                where: criteria,
                include: include,
                distinct: true

            }).then(TotalCount => {
                //Adjust page offset and limit to the total count
                if (offset + limit > TotalCount) {
                    limit = count;
                    offset = 0;
                }
                //Now we actually do the search combining the criteria, inclusions, limit and offset
                prescription.findAll({
                    where: criteria,
                    include: include,
                    limit: limit,
                    offset: offset
                })
                    .then(
                        MyPrescriptions => {
                            MyPrescriptions.forEach(
                                MyPrescrition => {
                                    //We map from legacy person to patient
                                    MyPrescrition.MEDICATIONs.forEach(medication => {
                                        MyFhirPrescription = PrescToFhirPrescMapper(MyPrescrition, medication, completePatient);
                                        result.push(MyFhirPrescription);
                                    });
                                });
                            //With all the prescriptions we have in the result.array
                            //we assemble the entries
                            let entries = result.map(presc =>
                                new BundleEntry({
                                    fullUrl: baseUrl + 'MedicationRequest/' + presc.id,
                                    resource: presc
                                }));
                            //We assemble the bundle
                            //With the type, total, entries, id, and meta
                            let bundle = new Bundle({
                                id: uuidv4(),
                                meta: {
                                    lastUpdated: new Date()
                                },
                                type: "searchset",
                                total: TotalCount.count,
                                entry: entries

                            });
                            var OriginalQuery = baseUrl + "MedicationRequest";
                            var LinkQuery = baseUrl + "MedicationRequest";
                            var parNum = 0;
                            var linkParNum = 0;
                            //This is to reassemble the query
                            for (var param in context.req.query) {
                                console.log(param);
                                console.log(context.req.query[param]);
                                if (param != "base_version") {
                                    var sep = "&";
                                    parNum = parNum + 1;

                                    if (parNum == 1) { sep = "?"; }
                                    OriginalQuery = OriginalQuery + sep + param + "=" + context.req.query[param];


                                    if ((param != "_page") && (param != "_count")) {

                                        var LinkSep = "&";
                                        linkParNum = linkParNum + 1;
                                        if (linkParNum == 1) { LinkSep = "?"; }
                                        LinkQuery = LinkQuery + LinkSep + param + "=" + context.req.query[param];
                                    }

                                }
                            };
                            //self is always there
                            MyLinks = [{
                                relation: "self",
                                url: OriginalQuery
                            }];
                            //prev and next may or not exist
                            if (pageInt > 1) {
                                const prevPage = pageInt - 1;
                                MyLinks.push({
                                    relation: "prev",
                                    url: LinkQuery + "&_count=" + coun + "&_page=" + prevPage.toString()
                                });
                            }
                            MaxPages = (TotalCount.count / coun) + 1;
                            MaxPages = parseInt(MaxPages);
                            if (pageInt < MaxPages) {

                                const nextPage = pageInt + 1;
                                MyLinks.push({
                                    relation: "next",
                                    url: LinkQuery + "&_count=" + coun + "&_page=" + nextPage.toString()
                                });
                            }
                            bundle.link = MyLinks;
                            resolve(bundle);
                        });
            });
        });
}
// This funcion receives a legacy prescription and returns a FHIR medicationRequest
function PrescToFhirPrescMapper(prescription, medication, completePatient) {
    let { id, name, status, form, amount, ingredients, lotNumber, expiration } = medication;
    let R = new getMedicationRequest();
    if (prescription) {
        R.id = prescription.id.toString();
        R.identifier = [
            {
                use: "official",
                system: "http://www.bmc.nl/portal/prescriptions",
                value: prescription.id
            }
        ];
        R.form = {
            coding: [
                {
                    system: "http://snomed.info/sct",
                    code: "421026006", // It's a fake!
                    display: form
                }
            ]
        };
        R.status = 'active';
        R.intent = "order",
            R.text = {  // Hardcoded data
                "status": "generated",
                "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\"><p><b>Generated Narrative with Details</b></p><p><b>id</b>: medrx0304</p><p><b>contained</b>: </p><p><b>identifier</b>: 12345689 (OFFICIAL)</p><p><b>status</b>: completed</p><p><b>intent</b>: order</p><p><b>medication</b>: Nystatin 100,000 u/ml oral suspension. Generated Summary: id: med0312; Nystatin 100,000 units/ml oral suspension (product) <span>(Details : {SNOMED CT code '324689003' = 'Nystatin 100,000units/mL oral suspension', given as 'Nystatin 100,000 units/ml oral suspension (product)'})</span></p><p><b>subject</b>: <a>Donald Duck</a></p><p><b>authoredOn</b>: 15/01/2015</p><p><b>requester</b>: <a>Patrick Pump</a></p><p><b>dosageInstruction</b>: </p><h3>DispenseRequests</h3><table><tr><td>-</td><td><b>ValidityPeriod</b></td><td><b>NumberOfRepeatsAllowed</b></td><td><b>Quantity</b></td><td><b>ExpectedSupplyDuration</b></td></tr><tr><td>*</td><td>15/01/2015 --&gt; 15/01/2016</td><td>3</td><td>10 ml<span> (Details: UCUM code ml = 'ml')</span></td><td>10 days<span> (Details: UCUM code d = 'd')</span></td></tr></table></div>"
            };
        R.contained = [];
        R.contained.push({
            resourceType: "Medication",
            id: id,
            code: {
                coding: [
                    {
                        "system": "http://snomed.info/sct",
                        "code": '324689003',  // It's a fake!
                        "display": `${name} ${amount}`
                    }
                ]
            }
        });
        R.medicationReference = {
            reference: `#${id}`,
            display: name
        };
        R.subject = {
            reference: `Patient/${prescription.patient_id}`,
            display: `${completePatient.PRSN_FIRST_NAME} ${completePatient.PRSN_LAST_NAME}`
        }
    }
    return R;
}

module.exports.searchById = (args, context, logger) => new Promise(async (resolve, reject) => {
    console.log('Search by id');
    let { base_version, id } = args;

    let person = new Person(sequelize, DataTypes);
    let medication = new Medication(sequelize, DataTypes);
    let prescription = new Prescription(sequelize, DataTypes);
    let medication_prescription = new Medication_Prescription(sequelize, DataTypes);
    prescription.belongsTo(person, {
        as: "PERSON",
        foreignKey: 'patient_id'
    });

    medication.belongsToMany(prescription, { through: medication_prescription });
    prescription.belongsToMany(medication, { through: medication_prescription });

    try {
        let fhirPrescription = null;
        const pres = await prescription.findOne({
            where: { id },
            include: [{
                model: medication
            }]
        });
        const patient = await person.findOne({
            where: { PRSN_ID: pres.patient_id }
        });
        pres.MEDICATIONs.forEach(medication => {
            fhirPrescription = PrescToFhirPrescMapper(pres, medication, patient);
        });

        resolve(fhirPrescription);
    } catch (e) {
        reject(e);
    }
})
