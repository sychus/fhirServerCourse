module.exports = function (sequelize, DataTypes) {
    const MEDICATION_PRESCRIPTION = sequelize.define('MEDICATION_PRESCRIPTION', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false
        },
        active: DataTypes.BOOLEAN
    }, {
        tableName: 'MEDICATION_PRESCRIPTION',
        freezeTableName: true,
        timestamps: false
    });
    return MEDICATION_PRESCRIPTION;
};