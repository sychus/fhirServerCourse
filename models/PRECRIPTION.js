module.exports = function (sequelize, DataTypes) {
    const PRESCRIPTION = sequelize.define('PRESCRIPTION', {
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
        patient_id: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        observations: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    }, {
        tableName: 'PRESCRIPTION',
        freezeTableName: true,
        timestamps: false
    });
    return PRESCRIPTION;
};