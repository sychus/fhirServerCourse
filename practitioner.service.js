const { DataTypes } = require("sequelize");
const sequelize = require('./dbconfig').db;
//Specific models for our legacy person object
const Person = require('./models/PERSON');
const PersonDoc = require('./models/PERSON_DOC');
const DocType = require('./models/DOC_TYPE');
//Mapping between FHIR system and legacy document type
const LegacyDocumentType = require('./legacy_document_type');
//UID generator for bundles
const uuidv4 = require('uuid').v4;
//FHIR specific stuff: Server, resources: Practitioner, Bundle, OperationOutcome and Entry
const { RESOURCES } = require('@asymmetrik/node-fhir-server-core').constants;
const FHIRServer = require('@asymmetrik/node-fhir-server-core');
const getPractitioner = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/practitioner');
const getBundle = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/bundle');
const getOperationOutcome = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/operationoutcome');
const getBundleEntry = require('@asymmetrik/node-fhir-server-core/src/server/resources/4_0_0/schemas/bundleentry');
//Meta data for FHIR R4
let getMeta = (base_version) => {
    return require(FHIRServer.resolveFromVersion(base_version, RESOURCES.META));
};
//How to search the address of our server, so we can return it in the fullURL for each Practitioner entry
function GetBaseUrl(context) {
    var baseUrl = "";
    const FHIRVersion = "/4_0_0/";
    var protocol = "http://";
    if (context.req.secure) { protocol = "https://"; }
    baseUrl = protocol + context.req.headers.host + FHIRVersion;
    return baseUrl;

};
//This is for Practitioner searches (direct read is special, below)
module.exports.search = (args, context, logger) => new Promise((resolve, reject) => {
    //	logger.info('Practitioner >>> search');

    // Common search params, we only support _id
    let { base_version, _content, _format, _id, _lastUpdated, _profile, _query, _security, _tag } = args;

    // Search Result params ,we only support _count
    let { _INCLUDE, _REVINCLUDE, _SORT, _COUNT, _SUMMARY, _ELEMENTS, _CONTAINED, _CONTAINEDTYPED } = args;


    let baseUrl = GetBaseUrl(context);
    // These are the parameters we can search for : name, identifier, family, gender and birthDate
    let name = args['name'];
    let iden = args['identifier'];
    let fami = args['family'];
    let gend = args['gender'];
    let birt = args['birthdate'];
    // Special parameters to support pagination
    let coun = context.req.query['_count'];
    let page = context.req.query['_page'];
    // Special search parameter to search by Id instead of direct read
    let idx = args[_id];
    // Our instance of the tables of the legacy database
    let person = new Person(sequelize, DataTypes);
    let personDoc = new PersonDoc(sequelize, DataTypes);
    let docType = new DocType(sequelize, DataTypes);
    // We declare sequelizer the relations between the tables
    personDoc.belongsTo(docType, {
        as: 'DOC_TYPE',
        foreignKey: 'PRDT_DCTP_ID'

    });

    person.hasMany(personDoc, { as: 'PERSON_DOC', foreignKey: 'PRDT_PRSN_ID' });

    // These are the operators for and/or in sequelizer. We need a few of them

    const { Op } = require("sequelize");
    // Definining our array for search criteria
    // The criteria in the request translated to what sequelize expects for our tables
    let criteria = [];
    // If the family name is a parameter in this specific request...
    if (fami) {
        criteria.push({ PRSN_LAST_NAME: fami });
    }
    // If the gender is a parameter...
    if (gend) {
        criteria.push({ PRSN_GENDER: gend });
    }
    // If the birth date is a parameter...

    if (birt) {
        criteria.push({ PRSN_BIRTH_DATE: birt });
    }
    // If the _id is a parameter
    if (idx) {
        criteria.push({ prsn_id: idx });
    }
    // If name is a parameter we need to look in every name part, and do an OR
    if (name) {
        criteria.push({
            [Op.or]: [{
                PRSN_LAST_NAME: {
                    [Op.like]: '%' + name + '%'
                }
            },
            {
                PRSN_FIRST_NAME: {
                    [Op.like]: '%' + name + '%'
                }
            },
            {
                PRSN_SECOND_NAME: {
                    [Op.like]: '%' + name + '%'
                }
            }
            ]
        });
    }


    //We want sequelize to traverse the tables and get us all together: PERSONS, DOCUMENTS, DOCUMENT CODES
    include = [{
        model: personDoc,
        as: 'PERSON_DOC',
        where: { PRDT_DCTP_ID: 3 }, // To filter practitioner
        include: [{
            model: docType,
            as: 'DOC_TYPE'
        }]
    }];

    if (iden) {
        //splitting the token system|value
        var search_type = "";
        var search_value = "";
        v = iden.split("|");
        //If system is specified
        if (v.length > 1) {
            search_system = v[0];
            //Get the legacy type corresponding to the system
            let legacyMapper = LegacyDocumentType;
            search_type = legacyMapper.GetDocumentType(search_system);
            search_value = v[1];
        } else {
            search_value = iden;
        }
        //This function gets the primary key for all the persons with the same
        //identifier. Hopefully, only one of them
        GetPersonsByIdentifier(personDoc, docType, search_type, search_value)
            .then(
                result => {
                    //For each person with the same identifier, add the person id to the criteria
                    result.forEach(item => { criteria.push(item); });
                    //Now with the complete criteria, search all the Practitioners and assemble the bundle
                    GetPractitioner(person, include, criteria, context, coun, page)
                        .then(result => { resolve(result); })
                }
            )

    } else {
        //Normal search using all the criteria but 'identifier'
        GetPractitioner(person, include, criteria, context, coun, page)
            .then(result => { resolve(result); })

    }


});
//This function/promise returns an array of sequelize criteria with 
//the legacy person id with a specific document type/number

function GetPersonsByIdentifier(personDoc, docType, searchType, searchValue) {
    return new Promise(

        function (resolve, reject) {
            //Empty array of person id's
            persons = [];
            //Special type of identifier: "NPI" because it's not really an identifier
            //It's the server assigned NPI (practitioners ID)
            if (searchType == "NPI") {
                persons.push({ PRSN_ID: searchValue })
                resolve(persons);
            } else {
                // Association between DOC_TYPE and PERSON_DOC to search by the abbreviated type and not by ID
                let include = [{
                    model: docType,
                    as: 'DOC_TYPE',
                    where: { DCTP_ID: 3 }
                }];

                if (searchType != "") {
                    include.where = [{ DCTP_ABREV: searchType }];
                }
                // Criteria involves the document number
                let criteria = [];
                criteria.push({ PRDT_DOC_VALUE: searchValue })
                // Here we ask for all the persons matching the criteria
                personDoc.findAll({
                    where: criteria,
                    include: include
                }).then(
                    personDocs => {
                        personDocs.forEach(
                            personDoc => {
                                //And add them to the criteria array
                                persons.push({ PRSN_ID: personDoc.PRDT_PRSN_ID })
                            }
                        );
                        if (persons.length == 0) {
                            //tricky: there was no person we add something that will always fail
                            //in a autonumeric INT, to ensure that we will return no 
                            //Practitioner at all
                            persons.push({ PRSN_ID: -1 });
                        }
                        //And that's our completed job
                        resolve(persons);
                    }

                );
            }
        })
}
//This is the specific search for all Practitioners matching the query
//
function GetPractitioner(person, include, criteria, context, coun, page) {
    return new Promise(

        function (resolve, reject) {
            //Here we solve paginations issues: how many records per page, which page
            let offset = 0
            let limit = 0
            if (!coun) { coun = 5; }
            if (coun == "") { coun = 5; }
            let pageSize = parseInt(coun);

            if (!page) { page = 1; }
            if (page == "") { page = 1; }
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
            //Get total number of rows
            //because we want to know how many records in total we have
            //to report that in our searchset bundle

            person.findAndCountAll({
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
                person.findAll({
                    where: criteria,
                    include: include,
                    limit: limit,
                    offset: offset
                })
                    .then(
                        MyPersons => {
                            MyPersons.forEach(
                                MyPerson => {
                                    //We map from legacy person to practitioner
                                    MyPractitioner = PersonToPractitionerMapper(MyPerson);
                                    //Add the identifiers
                                    MyPractitioner = PersonIdentifierToPractitionerIdentifierMapper(MyPractitioner, MyPerson);
                                    //And save the result in an array
                                    result.push(MyPractitioner);
                                });
                            //With all the practitioners we have in the result.array
                            //we assemble the entries
                            let entries = result.map(practitioner =>
                                new BundleEntry({
                                    fullUrl: baseUrl + '/Practitioner/' + practitioner.id,
                                    resource: practitioner
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
                            //And finally, we generate the link element
                            //self (always), prev (if there is a previous page available)
                            //next (if there is a next page available)
                            var OriginalQuery = baseUrl + "Practitioner";
                            var LinkQuery = baseUrl + "Practitioner";
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
                            //Now we have all the required elements 
                            //So we can return the complete bundle
                            resolve(bundle);


                        });

            });


        });
}
// Person to Practitioner mapper
// This funcion receives a legacy person and returns a FHIR Practitioner
// 
function PersonToPractitionerMapper(MyPerson) {

    let R = new getPractitioner();
    if (MyPerson) {
        //Logical server id
        R.id = MyPerson.PRSN_ID.toString();
        //We only have family, given and text
        //If we have more than one given, we will adjust later
        R.name = [{
            use: "official",
            family: MyPerson.PRSN_LAST_NAME,
            given: [MyPerson.PRSN_FIRST_NAME],

            text: MyPerson.PRSN_FIRST_NAME + " " + MyPerson.PRSN_LAST_NAME

        }];
        //Mapping of gender is not needed because it's the same codes
        R.gender = MyPerson.PRSN_GENDER;
        //BirthDate no conversion needed
        R.birthDate = MyPerson.PRSN_BIRTH_DATE;
        //If there is second name then we add the given
        //and adjust the text element
        if (MyPerson.PRSN_SECOND_NAME != "") {
            R.name[0].given.push(MyPerson.PRSN_SECOND_NAME);
            R.name[0].text = R.name.text = MyPerson.PRSN_FIRST_NAME + " " + MyPerson.PRSN_SECOND_NAME + " " + MyPerson.PRSN_LAST_NAME;

        }
        //We map our legacy identifier type to FHIR system
        let legacyMapper = LegacyDocumentType;
        mapper = legacyMapper.GetDocumentSystemUse("NPI");
        //We have the identifier (use, system, value)
        R.identifier = [{
            use: mapper.use,
            system: mapper.system,
            value: MyPerson.PRSN_ID.toString(),
            period: { start: MyPerson.createdAt }
        }];
        //We assemble the email address
        R.telecom = [{
            system: "email",
            value: MyPerson.PRSN_EMAIL
        }];
        //If there is a nick name, we add it
        if (MyPerson.PRSN_NICK_NAME != "") {
            legal_name = R.name[0];
            R.name = [
                legal_name,
                {
                    use: "nickname",
                    given: [MyPerson.PRSN_NICK_NAME]
                }
            ];
        }
        //Full text for the resource
        //NO automatic narrative

        R.text = {
            "status": "generated",
            "div": '<div xmlns="http://www.w3.org/1999/xhtml">' + R.name[0].text + "</div>"
        };
    }
    //And that's our resource
    return R;
}
//Providing special support for the person's identifiers 
function PersonIdentifierToPractitionerIdentifierMapper(R, MyPerson) {
    //Our helper for transforming the legacy to system/value
    let legacyMapper = LegacyDocumentType;
    MyDocs = MyPerson.PERSON_DOC;

    if (MyDocs) {
        // For each legacy identifier
        MyDocs.forEach(doc => {
            var docTypeCode = doc.DOC_TYPE.DCTP_ABREV;
            var docNumber = doc.PRDT_DOC_VALUE;
            var startDate = doc.createdAt
            var mapped = legacyMapper.GetDocumentSystemUse(docTypeCode);
            if (mapped.system != "") {
                //Assemble each identifier
                //use-system-value-period
                var oldCol = R.identifier;
                oldCol.push({
                    use: mapped.use,
                    system: mapped.system,
                    value: docNumber,
                    period: { start: startDate }
                })
                R.identifier = oldCol;

            }
        });
        return R;
    }
}

module.exports.searchById = (args, context, logger) => new Promise((resolve, reject) => {
    //	logger.info('Practitioner >>> searchById');
    let { base_version, id } = args;
    let person = new Person(sequelize, DataTypes);
    let personDoc = new PersonDoc(sequelize, DataTypes);
    let docType = new DocType(sequelize, DataTypes);
    personDoc.belongsTo(docType, {
        as: 'DOC_TYPE',
        foreignKey: 'PRDT_DCTP_ID'

    });
    person.hasMany(personDoc, { as: 'PERSON_DOC', foreignKey: 'PRDT_PRSN_ID' });


    person
        .findOne({
            where: { prsn_id: id },
            include: [{
                model: personDoc,
                as: 'PERSON_DOC',
                include: [{
                    model: docType,
                    as: 'DOC_TYPE',
                    where: { DCTP_ID: 3 }
                }]
            }]
        })
        .then(
            MyPerson => {
                if (MyPerson) {

                    R = PersonToPractitionerMapper(MyPerson);
                    R = PersonIdentifierToPractitionerIdentifierMapper(R, MyPerson);
                    resolve(R);
                } else {
                    let OO = new getOperationOutcome();
                    let legacyMapper = LegacyDocumentType;
                    var mapped = legacyMapper.GetDocumentSystemUse("NPI");
                    var message = "Practitioner with identifier " + mapped.system + " " + id + " not found ";
                    OO.issue = [{
                        "severity": "error",
                        "code": "processing",
                        "diagnostics": message
                    }]
                    resolve(OO);
                }
            })
        .catch(error => {
            let OO = new getOperationOutcome();
            var message = error;
            OO.issue = [{
                "severity": "error",
                "code": "processing",
                "diagnostics": message
            }]
            resolve(OO);


        })
})