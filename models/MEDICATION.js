module.exports = function (sequelize, DataTypes) {
    const MEDICATION = sequelize.define('MEDICATION', {
        id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            autoIncrement: true,
            primaryKey: true
        },
        name: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        status: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        form: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        amount: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        ingredients: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        lotNumber: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        expiration: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    }, {
        tableName: 'MEDICATION',
        freezeTableName: true,
        timestamps: false
    });
    return MEDICATION;
};